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
import { AuthorizationEvaluator } from "../auth/evaluator.js";
import { DEFAULT_POLICY, describePolicy, parsePolicy, type LoadedPolicy } from "../auth/policy.js";
import { Inbox, type DecisionKey, type InboxItem } from "../auth/inbox.js";
import { ProposalStore, ProposalConflictError, type Proposal, type ProposalChange } from "../auth/proposals.js";

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
  /** Loaded standing policy; defaults apply when no file is present. */
  policy?: LoadedPolicy;
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
  private readonly loadedPolicy: LoadedPolicy;
  private readonly evaluator: AuthorizationEvaluator;
  private readonly proposalStore: ProposalStore;
  /** Built after `writer` exists so it can project only committed events. */
  private inboxStore!: Inbox;

  constructor(private readonly deps: TaskServiceDeps) {
    this.db = deps.db;
    this.store = deps.store;
    this.artifacts = deps.artifacts;
    this.writer = deps.writer;
    this.now = deps.now ?? (() => new Date());
    this.loadedPolicy = deps.policy ?? { policy: DEFAULT_POLICY, source: "default" };
    this.evaluator = new AuthorizationEvaluator(this.loadedPolicy.policy);
    this.proposalStore = new ProposalStore(this.db);
  }

  static open(
    config: ServiceConfig,
    options: {
      now?: () => Date;
      dbPath?: string;
      bus?: TypedEventBus;
      onEventError?: (error: unknown) => void;
      policy?: LoadedPolicy;
    } = {},
  ): { service: TaskService; db: Database; bus: TypedEventBus; writer: TransitionWriter } {
    ensureHome(config.home);
    const dbPath = options.dbPath ?? config.databasePath;
    const db = new DatabaseClass(dbPath);
    migrate(db);
    const store = new TaskStore(db);
    const artifacts = ArtifactStore.create(config.home);
    const bus = options.bus ?? new TypedEventBus();
    const writer = new TransitionWriter(db, bus, options.onEventError);
    const service = new TaskService({ db, store, artifacts, config, writer, now: options.now, policy: options.policy });
    service.attachInbox(bus);
    return { service, db, bus, writer };
  }

  /**
   * Builds the attention-firewall projection and subscribes it to the bus. The
   * inbox only ever sees committed events (the bus publishes after commit), and
   * it ignores everything outside the three permitted event classes.
   */
  private attachInbox(bus: TypedEventBus): void {
    this.inboxStore = new Inbox(this.db);
    bus.on("*", (event) => {
      // Resolve a stale card before projecting: a completed task clears its
      // "needs decision" card instead of leaving both on screen.
      if (event.type === "task_completed" || event.type === "task_failed") {
        this.inboxStore.resolve(event.taskId, "decision_required");
      }
      this.inboxStore.project(event);
    });
  }

  /** Read access to the attention-firewall inbox. */
  get inbox() {
    return this.inboxStore;
  }

  /** Current policy plus where it came from, for the auth-health panel. */
  policySnapshot(): { source: string; summary: string; warning?: string } {
    return {
      source: this.loadedPolicy.source,
      summary: describePolicy(this.loadedPolicy.policy),
      ...(this.loadedPolicy.warning ? { warning: this.loadedPolicy.warning } : {}),
    };
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

  /**
   * Evaluates a worker's permission request against the standing policy.
   *
   * - Tier 0: allowed, nothing recorded beyond the audit trail.
   * - Tier 1: the chief of staff issues a new grant revision silently.
   * - Tier 2: the task parks in `waiting(needs_human_decision)` and one inbox
   *   card is upserted for the user.
   */
  requestAuthorization(taskId: string, request: { action: string; environment?: string | null; resource?: string | null }): {
    decision: "allow" | "auto_grant" | "needs_human" | "deny";
    tier: number;
    grantVersion?: number;
    reason?: string;
  } {
    const view = this.store.view(taskId);
    if (!view) throw new TaskNotFoundError(`task ${taskId} not found`);
    const decision = this.evaluator.classify(request);
    const now = toIso(this.now());

    if (decision.kind === "allow") {
      this.audit(taskId, request, 0, "policy", "tier 0 default allow", now);
      return { decision: "allow", tier: 0 };
    }
    if (decision.kind === "deny") {
      this.audit(taskId, request, -1, "policy", decision.reason, now);
      return { decision: "deny", tier: -1, reason: decision.reason };
    }
    if (decision.kind === "auto_grant") {
      // Tier 1 stays silent: a new grant revision plus an audit row, no inbox card.
      const grant = {
        action: request.action,
        resource: request.resource ?? "*",
        environment: request.environment ?? null,
        identity: "chief_of_staff",
        expiresAt: null,
      };
      let grantVersion = view.authorizationVersion;
      this.writer.commit({
        taskId,
        type: "run_observed",
        payload: { authorization: { action: request.action, tier: 1 } },
        options: { idempotencyKey: `grant:${request.action}:${view.authorizationVersion + 1}`, now },
        project: () => {
          grantVersion = this.store.appendGrantRevision(taskId, [...view.grants, grant], now);
        },
      });
      this.audit(taskId, request, 1, "chief_of_staff", "auto-granted within standing policy", now, grantVersion);
      return { decision: "auto_grant", tier: 1, grantVersion };
    }

    // Tier 2 red line: park the task and raise exactly one decision card.
    const reason = decision.reason;
    this.writer.commit({
      taskId,
      type: "decision_required",
      payload: {
        action: request.action,
        environment: request.environment ?? null,
        resource: request.resource ?? null,
        reason,
        options: ["批准", "拒绝"],
      },
      options: {
        idempotencyKey: `decision:${request.action}:${view.authorizationVersion}`,
        now,
        enqueue: [{ kind: JOB_DISPATCH, dedupeKey: `resume:${request.action}`, runAfter: now }],
      },
      project: () => {
        this.store.setStatus(taskId, "waiting", "needs_human_decision", now);
        this.store.enqueueNotification(taskId, "needs_human_decision", { action: request.action, reason }, now);
      },
    });
    this.audit(taskId, request, 2, "user", reason, now);
    return { decision: "needs_human", tier: 2, reason };
  }

  /** Records an approval/denial of a red-line request and resumes or closes it. */
  resolveAuthorization(taskId: string, input: { action: string; approved: boolean; reason?: string }): { status: TaskStatus } {
    const view = this.store.view(taskId);
    if (!view) throw new TaskNotFoundError(`task ${taskId} not found`);
    const now = toIso(this.now());
    let grantVersion = view.authorizationVersion;
    this.writer.commit({
      taskId,
      type: "run_observed",
      payload: { authorization: { action: input.action, approved: input.approved } },
      options: { idempotencyKey: `decision-resolved:${input.action}:${input.approved}`, now },
      project: () => {
        this.inboxStore.resolve(taskId, "decision_required", now);
        if (input.approved) {
          grantVersion = this.store.appendGrantRevision(
            taskId,
            [...view.grants, { action: input.action, resource: "*", environment: null, identity: "user", expiresAt: null }],
            now,
          );
          // Approval resumes in place; the task keeps its worktree and progress.
          this.store.setStatus(taskId, "waiting", "retrying", now);
        } else {
          this.store.setStatus(taskId, "failed", null, now);
          this.store.setFailure(taskId, `user declined ${input.action}`, now);
        }
      },
    });
    this.audit(taskId, { action: input.action }, 2, "user", input.approved ? "user approved" : "user declined", now, grantVersion);
    return { status: this.store.get(taskId)!.status };
  }

  /** Two-phase change: records the diff card without touching the task. */
  proposeChange(taskId: string, input: { change: ProposalChange; reason: string }): Proposal {
    const view = this.store.view(taskId);
    if (!view) throw new TaskNotFoundError(`task ${taskId} not found`);
    if (isTerminal(view.task.status)) {
      throw new TaskConflictError("task_terminated", `task ${taskId} is ${view.task.status} and cannot be changed`);
    }
    return this.proposalStore.create({
      taskId,
      change: input.change,
      expectedBriefVersion: view.briefVersion,
      expectedGrantVersion: view.authorizationVersion,
      reason: input.reason,
    });
  }

  /**
   * Applies a confirmed proposal. The revision guard runs again here: if the task
   * moved since the proposal was drafted, the change is refused rather than
   * clobbering newer work.
   */
  confirmProposal(proposalId: string): { applied: boolean; briefVersion: number } {
    const proposal = this.proposalStore.get(proposalId);
    if (!proposal) throw new TaskNotFoundError(`proposal ${proposalId} not found`);
    const view = this.store.view(proposal.taskId);
    if (!view) throw new TaskNotFoundError(`task ${proposal.taskId} not found`);
    if (view.briefVersion !== proposal.expectedBriefVersion || view.authorizationVersion !== proposal.expectedGrantVersion) {
      throw new ProposalConflictError("stale_revision", `proposal ${proposalId} was drafted on an older revision`);
    }
    this.proposalStore.markConfirmed(proposalId);
    const now = toIso(this.now());
    let briefVersion = view.briefVersion;
    if (proposal.change.kind === "brief" && proposal.change.brief) {
      const brief = proposal.change.brief;
      this.writer.commit({
        taskId: proposal.taskId,
        type: "task_amended",
        payload: { fromVersion: view.briefVersion, brief, proposalId },
        options: { idempotencyKey: `amended:${view.briefVersion + 1}`, now },
        project: () => {
          briefVersion = this.store.appendBriefRevision(proposal.taskId, proposal.reason, brief, now);
        },
      });
    } else if (proposal.change.kind === "grant" && proposal.change.grants) {
      const grants = proposal.change.grants;
      this.writer.commit({
        taskId: proposal.taskId,
        type: "run_observed",
        payload: { authorization: { granted: grants.length, proposalId } },
        options: { idempotencyKey: `grant-proposal:${proposalId}`, now },
        project: () => {
          this.store.appendGrantRevision(proposal.taskId, [...view.grants, ...grants], now);
        },
      });
    }
    this.inboxStore.resolve(proposal.taskId, "decision_required", now);
    return { applied: true, briefVersion };
  }

  cancelProposal(proposalId: string): { status: string } {
    const proposal = this.proposalStore.markCancelled(proposalId);
    return { status: proposal.status };
  }

  /** Inbox projection: only the three attention-worthy classes ever appear here. */
  listInbox(): InboxItem[] {
    return this.inboxStore.list();
  }

  private audit(
    taskId: string,
    request: { action: string; environment?: string | null; resource?: string | null },
    tier: number,
    approvedBy: string,
    reason: string,
    now: string,
    grantVersion?: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO authorization_audit (audit_id, task_id, action, environment, resource, tier, approved_by, grant_version, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        taskId,
        request.action,
        request.environment ?? null,
        request.resource ?? null,
        tier,
        approvedBy,
        grantVersion ?? null,
        reason,
        now,
      );
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
