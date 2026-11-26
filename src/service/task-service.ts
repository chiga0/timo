import type { Database } from "../store/database.js";
import { Database as DatabaseClass } from "../store/database.js";
import { migrate } from "../store/migrations.js";
import { TaskStore, RequestConflictError, type TaskResult, type TaskRow } from "../store/tasks.js";
import { ArtifactStore } from "../store/artifacts.js";
import { analyzeLog, verifyCandidate, SSE_VERIFIER_VERSION, type Finding } from "../sse/contract.js";
import { sha256Hex, newId, toIso, stableJson } from "../util.js";
import { ensureHome } from "../home.js";
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
  now?: () => Date;
}

/**
 * Business entry point shared by the CLI server and any future assistant
 * entry. It never talks to T3; the background runner does, under the same
 * store so that state transitions stay single-writer.
 */
export class TaskService {
  private readonly db: Database;
  private readonly store: TaskStore;
  private readonly artifacts: ArtifactStore;
  private readonly now: () => Date;

  constructor(private readonly deps: TaskServiceDeps) {
    this.db = deps.db;
    this.store = deps.store;
    this.artifacts = deps.artifacts;
    this.now = deps.now ?? (() => new Date());
  }

  static open(config: ServiceConfig, options: { now?: () => Date; dbPath?: string } = {}): { service: TaskService; db: Database } {
    ensureHome(config.home);
    const dbPath = options.dbPath ?? config.databasePath;
    const db = new DatabaseClass(dbPath);
    migrate(db);
    const store = new TaskStore(db);
    const artifacts = ArtifactStore.create(config.home);
    return { service: new TaskService({ db, store, artifacts, config, now: options.now }), db };
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

    if (!analysis.ok) {
      // Incomplete input is never dispatched: only `unknown` is accepted.
      this.db.transaction(() => {
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
    };
  }

  /** Internal: raw row for the runner. */
  row(taskId: string): TaskRow | undefined {
    return this.store.get(taskId);
  }

  /**
   * Verifies a submitted candidate against the frozen input and decides the
   * task. Only the deterministic verifier may move a task to `completed`.
   */
  acceptCandidate(taskId: string, candidate: unknown, taskRunId: string): { status: string; findings: Finding[] } {
    const view = this.store.view(taskId);
    if (!view) throw new TaskNotFoundError(`task ${taskId} not found`);
    const input = this.artifacts.get(view.task.artifactPath);
    const now = toIso(this.now());
    const outcome = verifyCandidate(input, view.task.inputDigest, candidate);
    const candidateDigest = sha256Hex(Buffer.from(stableJson(candidate), "utf8"));

    this.db.transaction(() => {
      this.store.recordCandidate({
        taskId,
        taskRunId,
        briefVersion: view.briefVersion,
        candidate,
        candidateDigest,
        verification: {
          result: outcome.status,
          verifierVersion: outcome.verifierVersion,
          findings: outcome.status === "accepted" ? [] : outcome.findings,
          environment: "local",
        },
        now,
      });
      if (outcome.status === "accepted") {
        const seal: TaskResult = {
          verdict: outcome.expected.verdict,
          incidents: outcome.expected.incidents,
          inputDigest: outcome.digest,
          verifierVersion: outcome.verifierVersion,
        };
        this.store.setResult(taskId, seal, now);
        this.store.setStatus(taskId, "completed", null, now);
        this.store.setOperationStatus(`${taskId}:dispatch`, "done", { result: "completed" }, now);
        this.store.enqueueNotification(taskId, "task_completed", seal, now);
      } else if (outcome.status === "incomplete") {
        this.store.setStatus(taskId, "waiting", "input_incomplete", now);
        this.store.enqueueNotification(taskId, "task_waiting", { waitingReason: "input_incomplete", findings: outcome.findings }, now);
      } else {
        this.store.setStatus(taskId, "failed", null, now);
        this.store.setFailure(taskId, "candidate rejected by sse-v1 verifier", now);
        this.store.setOperationStatus(`${taskId}:dispatch`, "done", { result: "failed" }, now);
        this.store.enqueueNotification(taskId, "task_failed", { findings: outcome.findings }, now);
      }
    });
    return { status: outcome.status, findings: outcome.status === "accepted" ? [] : outcome.findings };
  }

  markWaiting(taskId: string, reason: string, now = toIso(this.now())): void {
    this.store.setStatus(taskId, "waiting", reason as never, now);
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
