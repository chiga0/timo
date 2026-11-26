import type { Database } from "../store/database.js";
import { Database as DatabaseClass } from "../store/database.js";
import { migrate } from "../store/migrations.js";
import {
  TaskStore,
  RequestConflictError,
  canStop,
  isTerminal,
  type BriefRequirements,
  type TaskResult,
  type TaskRow,
  type TaskStatus,
  type WaitingReason,
} from "../store/tasks.js";
import { ArtifactStore } from "../store/artifacts.js";
import { analyzeLog, verifyCandidate, SSE_VERIFIER_VERSION, type Finding } from "../sse/contract.js";
import { sha256Hex, newId, toIso, stableJson } from "../util.js";
import { ensureHome } from "../home.js";
import { TypedEventBus } from "../events/bus.js";
import { TransitionWriter, JOB_DISPATCH } from "../events/writer.js";
import type { ServiceConfig, CreateTaskRequest, CreateTaskResponse, GetTaskResponse } from "../config.js";

export class TaskNotFoundError extends Error {
  override readonly name = "TaskNotFoundError";
}

/** Input shorter or larger than the contract goes to `invalid_input` (exit 2). */
export class InvalidInputError extends Error {
  override readonly name = "InvalidInputError";
}

export interface TaskServiceDeps {
  db: Database;
  store: TaskStore;
  artifacts: ArtifactStore;
  config: ServiceConfig;
  writer: TransitionWriter;
  now?: () => Date;
}

/**
 * Business entry point shared by the CLI server and any future assistant
 * entry. It never talks to T3; the background runner does, under the same
 * store so that state transitions stay single-writer. Every transition goes
 * through `TransitionWriter`, so the event ledger, the projection and the
 * follow-up jobs commit together and broadcast only after commit.
 */
export class TaskService {
  private readonly db: Database;
  private readonly store: TaskStore;
  private readonly artifacts: ArtifactStore;
  private readonly writer: TransitionWriter;
  private readonly now: () => Date;

  constructor(private readonly deps: TaskServiceDeps) {
    this.db = deps.db;
    this.store = deps.store;
    this.artifacts = deps.artifacts;
    this.writer = deps.writer;
    this.now = deps.now ?? (() => new Date());
  }

  static open(
    config: ServiceConfig,
    options: { now?: () => Date; dbPath?: string; bus?: TypedEventBus; onEventError?: (error: unknown) => void } = {},
  ): { service: TaskService; db: Database; bus: TypedEventBus; writer: TransitionWriter } {
    ensureHome(config.home);
    const dbPath = options.dbPath ?? config.databasePath;
    const db = new DatabaseClass(dbPath);
    migrate(db);
    const store = new TaskStore(db);
    const artifacts = ArtifactStore.create(config.home);
    const bus = options.bus ?? new TypedEventBus();
    const writer = new TransitionWriter(db, bus, options.onEventError);
    return { service: new TaskService({ db, store, artifacts, config, writer, now: options.now }), db, bus, writer };
  }

  /** Read access to the ledger for SSE replay and tests. */
  get ledger() {
    return this.writer.ledger;
  }

  get outbox() {
    return this.writer.outbox;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Accepts a task and freezes its input. Dedupes on `requestId`: identical
   * bytes return the original task, different bytes conflict.
   */
  createTask(request: CreateTaskRequest): CreateTaskResponse & { reused: boolean } {
    const requestId = request.requestId.trim();
    if (requestId === "" || requestId.length > 200 || /[\r\n]/.test(requestId)) {
      throw new InvalidInputError("--request-id must be a non-empty single-line string of at most 200 characters");
    }
    const input = request.log;
    if (input.byteLength > 32 * 1024) throw new InvalidInputError("log input exceeds 32 KiB");
    if (!isValidUtf8(input)) throw new InvalidInputError("log input is not valid UTF-8");

    const inputDigest = sha256Hex(input);
    const requestText = request.requestText?.trim() ?? "";
    const requestDigest = sha256Hex(Buffer.from(stableJson({ requestId, inputDigest, requestText }), "utf8"));

    const existing = this.store.findByRequestId(requestId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new RequestConflictError(`request id ${requestId} was already used with different content`);
      }
      return { taskId: existing.taskId, status: existing.status, reused: true };
    }

    const analysis = analyzeLog(new TextDecoder("utf-8").decode(input));
    const artifact = this.artifacts.put(input);
    if (artifact.digest !== inputDigest) throw new Error("artifact digest mismatch");

    const now = toIso(this.now());
    const taskId = newId();
    const { task } = this.store.createTask({
      taskId,
      requestId,
      requestDigest,
      inputDigest,
      artifactPath: artifact.path,
      requestText,
      brief: {
        goal: "核对冻结 SSE 日志中的断连与恢复证据",
        must: ["提交 inputDigest 与冻结输入一致的候选", "事故逐项列出连接 ID、断连行号和恢复行号", "结论与日志事实相符"],
        mustNot: ["修改外部系统或原始日志", "编造行号或恢复记录"],
        evidence: ["原始日志第 1 行起的逐行事实", `验证器 ${SSE_VERIFIER_VERSION} 的确定性重算`],
      },
      grants: [
        { action: "read_log", resource: `artifact:${inputDigest}`, environment: null, identity: null, expiresAt: null },
        { action: "dispatch_analysis", resource: "t3:thread", environment: null, identity: "task-executor", expiresAt: null },
      ],
      environment: "t3-mcp",
      providerInstanceId: "pending",
      model: "pending",
      now,
    });

    // TASK_CREATED carries the dispatch job, so a crash right here still leaves
    // the intent durable and a new process resumes from the outbox.
    this.writer.commit({
      taskId,
      type: "task_created",
      payload: { inputDigest, requestId, artifactPath: artifact.path },
      options: {
        idempotencyKey: "created",
        now,
        enqueue: input.byteLength === 0 || analysis.ok === false ? [] : [{ kind: JOB_DISPATCH, dedupeKey: "initial" }],
      },
    });

    if (!analysis.ok) {
      // Incomplete input is never dispatched: only `unknown` is accepted.
      this.writer.commit({
        taskId,
        type: "task_waiting",
        payload: { waitingReason: "input_incomplete", reason: analysis.reason, line: analysis.line },
        options: { idempotencyKey: "waiting:input_incomplete:1", now },
        project: () => {
          this.store.recordCandidate({
            taskId,
            taskRunId: "none",
            briefVersion: 1,
            candidate: { inputDigest, verdict: "unknown", incidents: [] },
            candidateDigest: sha256Hex(Buffer.from(stableJson({ inputDigest, verdict: "unknown", incidents: [] }), "utf8")),
            verification: { result: "incomplete", verifierVersion: SSE_VERIFIER_VERSION, findings: [{ code: "input_incomplete", detail: `${analysis.reason}${analysis.line === null ? "" : ` (line ${analysis.line})`}` }], environment: "local" },
            now,
          });
          this.store.setStatus(taskId, "waiting", "input_incomplete", now);
          this.store.setOperationStatus(`${taskId}:dispatch`, "done", { skipped: "input_incomplete" }, now);
          this.store.enqueueNotification(taskId, "task_waiting", { waitingReason: "input_incomplete" }, now);
        },
      });
    }
    void task;
    return { taskId, status: this.store.get(taskId)!.status, reused: false };
  }

  getTask(taskId: string): GetTaskResponse {
    const view = this.store.view(taskId);
    if (!view) throw new TaskNotFoundError(`task ${taskId} not found`);
    const { task } = view;
    return {
      taskId: task.taskId,
      status: task.status,
      waitingReason: task.waitingReason,
      inputDigest: task.inputDigest,
      threadId: task.threadId,
      runId: task.runId,
      result: task.result,
      failureReason: task.failureReason,
      verification: view.verification
        ? { result: view.verification.result, verifierVersion: view.verification.verifierVersion, findings: view.verification.findings, createdAt: view.verification.createdAt }
        : null,
      lastObservedAt: task.updatedAt,
      // Callers need this to send a correct `expectedBriefVersion` to amend.
      briefVersion: view.briefVersion,
    };
  }

  /** Internal: raw row for the runner. */
  row(taskId: string): TaskRow | undefined {
    return this.store.get(taskId);
  }

  /** False once the task's execution generation has been revoked by a stop. */
  taskExecutionReachable(taskId: string): boolean {
    return this.store.executionReachable(taskId);
  }

  /**
   * Verifies a submitted candidate against the frozen input and decides the
   * task. Only the deterministic verifier may move a task to `completed`.
   */
  acceptCandidate(taskId: string, candidate: unknown, taskRunId: string): { status: string; findings: Finding[] } {
    const view = this.store.view(taskId);
    if (!view) throw new TaskNotFoundError(`task ${taskId} not found`);
    // A stopped task keeps its terminal state: a late completion from a revoked
    // execution generation must be recorded as evidence but never win.
    if (view.task.status === "stopping" || view.task.status === "stopped") {
      const now = toIso(this.now());
      this.store.setEvidence(taskId, "lateCandidate", { candidate, runId: taskRunId, status: view.task.status, observedAt: now }, now);
      this.store.enqueueNotification(taskId, "late_candidate_ignored", { status: view.task.status, runId: taskRunId }, now);
      return { status: "ignored_after_stop", findings: [] };
    }
    const input = this.artifacts.get(view.task.artifactPath);
    const now = toIso(this.now());
    const outcome = verifyCandidate(input, view.task.inputDigest, candidate);
    const candidateDigest = sha256Hex(Buffer.from(stableJson(candidate), "utf8"));

    const verification = {
      result: outcome.status,
      verifierVersion: outcome.verifierVersion,
      findings: outcome.status === "accepted" ? [] : outcome.findings,
      environment: "local",
    };
    const seal: TaskResult | null =
      outcome.status === "accepted"
        ? {
            verdict: outcome.expected.verdict,
            incidents: outcome.expected.incidents,
            inputDigest: outcome.digest,
            verifierVersion: outcome.verifierVersion,
          }
        : null;
    const rejectedFindings: Finding[] = outcome.status === "accepted" ? [] : outcome.findings;

    // Verification evidence and the resulting task event commit together, so a
    // completed task can never exist without the evidence that justified it.
    this.writer.commit({
      taskId,
      type: outcome.status === "accepted" ? "task_completed" : outcome.status === "incomplete" ? "task_waiting" : "task_failed",
      payload:
        outcome.status === "accepted"
          ? { result: seal }
          : outcome.status === "incomplete"
            ? { waitingReason: "input_incomplete", findings: rejectedFindings }
            : { reason: "candidate rejected by sse-v1 verifier", findings: rejectedFindings },
      options: { idempotencyKey: `verification:${outcome.status}:${candidateDigest.slice(0, 16)}`, now },
      project: () => {
        this.store.recordCandidate({
          taskId,
          taskRunId,
          briefVersion: view.briefVersion,
          candidate,
          candidateDigest,
          verification,
          now,
        });
        this.store.setEvidence(
          taskId,
          "lastVerification",
          { result: outcome.status, verifierVersion: outcome.verifierVersion, at: now },
          now,
        );
        if (outcome.status === "accepted" && seal) {
          this.store.setResult(taskId, seal, now);
          this.store.setStatus(taskId, "completed", null, now);
          this.store.setOperationStatus(`${taskId}:dispatch`, "done", { result: "completed" }, now);
          this.store.enqueueNotification(taskId, "task_completed", seal, now);
        } else if (outcome.status === "incomplete") {
          this.store.setStatus(taskId, "waiting", "input_incomplete", now);
          this.store.enqueueNotification(taskId, "task_waiting", { waitingReason: "input_incomplete", findings: rejectedFindings }, now);
        } else {
          this.store.setStatus(taskId, "failed", null, now);
          this.store.setFailure(taskId, "candidate rejected by sse-v1 verifier", now);
          this.store.setOperationStatus(`${taskId}:dispatch`, "done", { result: "failed" }, now);
          this.store.enqueueNotification(taskId, "task_failed", { findings: rejectedFindings }, now);
        }
      },
    });
    return { status: outcome.status, findings: rejectedFindings };
  }

  markWaiting(taskId: string, reason: WaitingReason, now = toIso(this.now())): void {
    this.writer.commit({
      taskId,
      type: "task_waiting",
      payload: { waitingReason: reason },
      options: { idempotencyKey: `waiting:${reason}:${now}`, now },
      project: () => {
        this.store.setStatus(taskId, "waiting", reason, now);
      },
    });
  }

  /**
   * Appends a new brief revision. `expectedBriefVersion` guards against a stale
   * writer overwriting a newer revision: a mismatch is a version conflict, and
   * the existing revision is left untouched.
   */
  amendTask(taskId: string, input: AmendTaskInput): { briefVersion: number } {
    const view = this.store.view(taskId);
    if (!view) throw new TaskNotFoundError(`task ${taskId} not found`);
    if (isTerminal(view.task.status)) throw new TaskConflictError("task_terminated", `task ${taskId} is ${view.task.status} and cannot be amended`);
    const current = view.briefVersion;
    if (input.expectedBriefVersion !== current) {
      throw new TaskConflictError(
        "version_conflict",
        `expected brief version ${input.expectedBriefVersion} but the task is at ${current}`,
        { expected: input.expectedBriefVersion, actual: current },
      );
    }
    const goal = input.goal?.trim() || view.brief.goal;
    const brief: BriefRequirements = {
      goal,
      must: input.must ? [...input.must] : view.brief.must,
      mustNot: input.mustNot ? [...input.mustNot] : view.brief.mustNot,
      evidence: input.evidence ? [...input.evidence] : view.brief.evidence,
    };
    if (stableJson(brief) === stableJson(view.brief)) {
      // A no-op amendment does not create a revision; the caller still gets the
      // current version so it can proceed from a known base.
      return { briefVersion: current };
    }
    const now = toIso(this.now());
    const requestText = input.requestText?.trim() || this.store.latestRequestText(taskId);
    let version = current;
    this.writer.commit({
      taskId,
      type: "task_amended",
      payload: { fromVersion: current, brief },
      options: { idempotencyKey: `amended:${current + 1}`, now },
      project: () => {
        version = this.store.appendBriefRevision(taskId, requestText, brief, now);
      },
    });
    return { briefVersion: version };
  }

  /**
   * Requests a stop. The task moves to `stopping` at once so no new dispatch is
   * accepted, and the current execution generation is revoked so a late run
   * result cannot be written back. Marking `stopped` happens after the in-flight
   * work is interrupted, and only for tasks that were stopped.
   */
  stopTask(taskId: string, input: StopTaskInput = {}): { status: TaskStatus } {
    const view = this.store.view(taskId);
    if (!view) throw new TaskNotFoundError(`task ${taskId} not found`);
    const status = view.task.status;
    if (status === "stopped" || status === "stopping") return { status };
    if (isTerminal(status)) throw new TaskConflictError("task_terminated", `task ${taskId} is already ${status}`);
    if (!canStop(status)) throw new TaskConflictError("invalid_state", `task ${taskId} cannot be stopped from ${status}`);

    const now = toIso(this.now());
    this.writer.commit({
      taskId,
      type: "task_stopping",
      payload: { reason: input.reason ?? "user_requested", previousStatus: status, threadId: view.task.threadId, runId: view.task.runId },
      options: { idempotencyKey: "stopping", now },
      project: () => {
        this.store.setStatus(taskId, "stopping", null, now);
        this.store.revokeExecutions(taskId, now);
        // Leaving this job queued would resurrect a stopped task after restart.
        this.writer.outbox.byTask(taskId).forEach((job) => {
          if (job.status === "pending" || job.status === "leased") this.writer.outbox.complete(job.jobId, now);
        });
        this.store.enqueueNotification(taskId, "task_stopping", { reason: input.reason ?? "user_requested" }, now);
      },
    });
    return { status: "stopping" };
  }

  /** Finalises a stop once the executor reported the interruption (or timed out). */
  markStopped(taskId: string, detail: { interrupted: boolean; message?: string }): { status: TaskStatus } {
    const task = this.store.get(taskId);
    if (!task) throw new TaskNotFoundError(`task ${taskId} not found`);
    if (task.status === "stopped") return { status: "stopped" };
    if (task.status !== "stopping") throw new TaskConflictError("invalid_state", `task ${taskId} is ${task.status}, not stopping`);
    const now = toIso(this.now());
    this.writer.commit({
      taskId,
      type: "task_stopped",
      payload: detail,
      options: { idempotencyKey: "stopped", now },
      project: () => {
        this.store.setStatus(taskId, "stopped", null, now);
        this.store.setOperationStatus(`${taskId}:dispatch`, "failed", { reason: "stopped" }, now);
        this.store.enqueueNotification(taskId, "task_stopped", detail, now);
      },
    });
    return { status: "stopped" };
  }

  /** Lists tasks for the Web console and `timo list`. */
  listTasks(limit = 200, status?: string): Array<{ taskId: string; status: TaskStatus; waitingReason: string | null; inputDigest: string; createdAt: string; updatedAt: string }> {
    const rows = this.store.listTasks(limit, status);
    return rows.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      waitingReason: task.waitingReason,
      inputDigest: task.inputDigest,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }));
  }
}

export interface AmendTaskInput {
  expectedBriefVersion: number;
  goal?: string;
  must?: string[];
  mustNot?: string[];
  evidence?: string[];
  requestText?: string;
}

export interface StopTaskInput {
  reason?: string;
}

/** Optimistic-concurrency or state conflicts (HTTP 409 / exit code 4). */
export class TaskConflictError extends Error {
  override readonly name = "TaskConflictError";
  constructor(
    readonly code: "version_conflict" | "task_terminated" | "invalid_state",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export { RequestConflictError };
