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
import { analyzeLog, verifyCandidate as verifyCandidateSync, SSE_VERIFIER_VERSION, type Finding } from "../sse/contract.js";
import { sha256Hex, newId, toIso, stableJson } from "../util.js";
import { ensureHome } from "../home.js";
import { TypedEventBus } from "../events/bus.js";
import { TransitionWriter, JOB_DISPATCH, JOB_POLL_CI } from "../events/writer.js";
import type { ServiceConfig, CreateTaskRequest, CreateTaskResponse, GetTaskResponse, RepoDeliveryState, TaskKind } from "../config.js";
import { AuthorizationEvaluator } from "../auth/evaluator.js";
import { DEFAULT_POLICY, describePolicy, type LoadedPolicy, type StandingPolicy } from "../auth/policy.js";
import { Inbox, type InboxItem } from "../auth/inbox.js";
import { ProposalStore, ProposalConflictError, type Proposal, type ProposalChange } from "../auth/proposals.js";
import {
  VerifierRegistry,
  computeRepoCandidateDigest,
  type PipelineOutcome,
  type VerificationFinding,
  type VerificationPlan,
} from "../verify/pipeline.js";
import { basename } from "node:path";

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
  /** Declarative verification registry; defaults to built-in plugins. */
  verifiers?: VerifierRegistry;
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
  private readonly inboxStore: Inbox;
  private readonly verifierRegistry: VerifierRegistry;

  constructor(private readonly deps: TaskServiceDeps) {
    this.db = deps.db;
    this.store = deps.store;
    this.artifacts = deps.artifacts;
    this.writer = deps.writer;
    this.now = deps.now ?? (() => new Date());
    this.loadedPolicy = deps.policy ?? { policy: DEFAULT_POLICY, source: "default" };
    this.evaluator = new AuthorizationEvaluator(this.loadedPolicy.policy);
    this.proposalStore = new ProposalStore(this.db);
    this.inboxStore = new Inbox(this.db);
    this.verifierRegistry = deps.verifiers ?? new VerifierRegistry();
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
    bus.on("*", (event) => {
      // Resolve a stale card before projecting: a completed task clears its
      // "needs decision" card instead of leaving both on screen.
      if (event.type === "task_completed" || event.type === "task_failed" || event.type === "task_stopped") {
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

  get verifiers(): VerifierRegistry {
    return this.verifierRegistry;
  }

  get standingPolicy(): StandingPolicy {
    return this.loadedPolicy.policy;
  }

  /** Read-only view of the task's current grants & execution generation (for Capability MCP Gateway). */
  getTaskView(taskId: string) {
    return this.store.view(taskId);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Accepts a task and freezes its input. Supports both legacy zero-repo SSE
   * log diagnosis (`sse_log`) and multi-repo delivery (`repo_delivery`).
   * Dedupes on `requestId`: identical payload returns the original task,
   * different payload conflicts.
   */
  createTask(request: CreateTaskRequest): CreateTaskResponse & { reused: boolean } {
    const requestId = request.requestId.trim();
    if (requestId === "" || requestId.length > 200 || /[\r\n]/.test(requestId)) {
      throw new InvalidInputError("--request-id must be a non-empty single-line string of at most 200 characters");
    }

    const kind: TaskKind = request.kind ?? (request.repos && request.repos.length > 0 ? "repo_delivery" : "sse_log");
    if (kind === "repo_delivery") {
      return this.createRepoDeliveryTask(requestId, request);
    }

    const input = request.log;
    if (!input) throw new InvalidInputError("log input is required for sse_log tasks");
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
    const verificationPlan: VerificationPlan = request.verificationPlan ?? {
      version: SSE_VERIFIER_VERSION,
      steps: [{ type: "log_citation", name: "sse-v1" }],
    };
    const { task } = this.store.createTask({
      taskId,
      kind: "sse_log",
      executorId: request.executorId ?? null,
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
        ...(request.grants ?? []).map((g) => ({
          action: g.action,
          resource: g.resource,
          environment: g.environment ?? null,
          identity: g.identity ?? null,
          expiresAt: g.expiresAt ?? null,
        })),
      ],
      verificationPlan,
      maxRepairRounds: request.maxRepairRounds ?? 0,
      environment: request.executorId ?? "t3-mcp",
      providerInstanceId: "pending",
      model: request.model ?? "pending",
      now,
    });

    // TASK_CREATED carries the dispatch job, so a crash right here still leaves
    // the intent durable and a new process resumes from the outbox.
    this.writer.commit({
      taskId,
      type: "task_created",
      payload: { inputDigest, requestId, artifactPath: artifact.path, kind: "sse_log" },
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

  private createRepoDeliveryTask(requestId: string, request: CreateTaskRequest): CreateTaskResponse & { reused: boolean } {
    const repos = request.repos ?? [];
    if (repos.length === 0) {
      throw new InvalidInputError("repo_delivery tasks require at least one repo");
    }
    const requestText = request.requestText?.trim() ?? "";
    if (requestText === "") {
      throw new InvalidInputError("repo_delivery tasks require a non-empty requestText");
    }
    const normalizedRepos: RepoDeliveryState[] = repos.map((repo) => {
      if (!repo.sourcePath?.trim() || !repo.baseRef?.trim()) {
        throw new InvalidInputError("each repo must specify sourcePath and baseRef");
      }
      return {
        name: repo.name?.trim() || basename(repo.sourcePath),
        sourcePath: repo.sourcePath,
        baseRef: repo.baseRef,
      };
    });
    const verificationPlan: VerificationPlan = request.verificationPlan ?? {
      version: "pipeline-v1",
      steps: [{ type: "command_check", name: "default-check", command: "npm test" }],
    };
    const specBytes = Buffer.from(
      stableJson({
        kind: "repo_delivery",
        requestText,
        executorId: request.executorId ?? "pi",
        repos: normalizedRepos,
        verificationPlan,
      }),
      "utf8",
    );
    const inputDigest = sha256Hex(specBytes);
    const requestDigest = sha256Hex(Buffer.from(stableJson({ requestId, inputDigest, requestText }), "utf8"));

    const existing = this.store.findByRequestId(requestId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new RequestConflictError(`request id ${requestId} was already used with different content`);
      }
      return { taskId: existing.taskId, status: existing.status, reused: true };
    }

    const artifact = this.artifacts.put(new Uint8Array(specBytes));
    const now = toIso(this.now());
    const taskId = newId();
    const maxRepairRounds =
      typeof request.maxRepairRounds === "number" && Number.isInteger(request.maxRepairRounds) && request.maxRepairRounds >= 0
        ? Math.min(request.maxRepairRounds, this.loadedPolicy.policy.budget.maxAttempts)
        : 2;

    this.store.createTask({
      taskId,
      kind: "repo_delivery",
      executorId: request.executorId ?? "pi",
      requestId,
      requestDigest,
      inputDigest,
      artifactPath: artifact.path,
      requestText,
      brief: {
        goal: requestText,
        must: ["在独立 worktree 中完成修改并提交候选 commit", "通过声明式独立验收管线且绑定精确候选 SHA"],
        mustNot: ["禁止生产发布（deploy_prod）", "禁止修改原仓库工作目录", "禁止绕过独立验收自报通过"],
        evidence: verificationPlan.steps.map((step) => `${step.type}:${step.name ?? ("repo" in step ? step.repo ?? "all" : "check")}`),
      },
      grants: [
        { action: "read_worktree", resource: "*", environment: "dev", identity: "task-executor", expiresAt: null },
        { action: "write_worktree", resource: "*", environment: "dev", identity: "task-executor", expiresAt: null },
        { action: "run_local_tests", resource: "*", environment: "dev", identity: "task-executor", expiresAt: null },
        { action: "read_ci_status", resource: "*", environment: "dev", identity: "task-executor", expiresAt: null },
        ...(request.grants ?? []).map((g) => ({
          action: g.action,
          resource: g.resource,
          environment: g.environment ?? null,
          identity: g.identity ?? null,
          expiresAt: g.expiresAt ?? null,
        })),
      ],
      repos: normalizedRepos,
      verificationPlan,
      maxRepairRounds,
      environment: request.executorId ?? "pi",
      providerInstanceId: request.executorId ?? "pi",
      model: request.model ?? "default",
      now,
    });

    this.writer.commit({
      taskId,
      type: "task_created",
      payload: {
        kind: "repo_delivery",
        inputDigest,
        requestId,
        executorId: request.executorId ?? "pi",
        repos: normalizedRepos.map((r) => ({ name: r.name, baseRef: r.baseRef })),
      },
      options: {
        idempotencyKey: "created",
        now,
        enqueue: [{ kind: JOB_DISPATCH, dedupeKey: "initial" }],
      },
    });

    return { taskId, status: this.store.get(taskId)!.status, reused: false };
  }

  getTask(taskId: string): GetTaskResponse {
    const view = this.store.view(taskId);
    if (!view) throw new TaskNotFoundError(`task ${taskId} not found`);
    const { task } = view;
    const operations = this.store.listOperations(taskId);
    return {
      taskId: task.taskId,
      kind: task.kind,
      executorId: task.executorId,
      status: task.status,
      waitingReason: task.waitingReason,
      inputDigest: task.inputDigest,
      threadId: task.threadId,
      runId: task.runId,
      result: task.result,
      failureReason: task.failureReason,
      verification: view.verification
        ? {
            result: view.verification.result,
            verifierVersion: view.verification.verifierVersion,
            findings: view.verification.findings,
            createdAt: view.verification.createdAt,
            stale: view.verification.stale,
            candidateDigest: view.verification.candidateDigest,
          }
        : null,
      repos: task.repos,
      verificationPlan: task.verificationPlan,
      operations: operations.map((op) => ({
        operationId: op.operationId,
        kind: op.kind,
        status: op.status,
        operationKey: op.operationKey,
        clientRequestId: op.clientRequestId,
        receipt: op.receipt,
        reconciledAt: op.reconciledAt,
      })),
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
    const outcome = verifyCandidateSync(input, view.task.inputDigest, candidate);
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
        this.store.invalidateStaleVerifications(taskId, candidateDigest);
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
          { result: outcome.status, verifierVersion: outcome.verifierVersion, candidateDigest, at: now },
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

  /**
   * Updates per-repo delivery state (baseSha, headSha, MR/CI metadata). When
   * any repo's candidate headSha changes, all prior verifications bound to the
   * older candidate combination are automatically marked `stale = 1` so stale
   * evidence can never satisfy completion.
   */
  updateRepoStates(taskId: string, repos: RepoDeliveryState[]): { candidateDigest: string | null; invalidated: number } {
    const view = this.store.view(taskId);
    if (!view) throw new TaskNotFoundError(`task ${taskId} not found`);
    const now = toIso(this.now());
    this.store.setRepos(taskId, repos, now);
    const withHead = repos.filter((r): r is RepoDeliveryState & { headSha: string } => typeof r.headSha === "string" && r.headSha.trim() !== "");
    if (withHead.length === 0) return { candidateDigest: null, invalidated: 0 };
    const candidateDigest = computeRepoCandidateDigest(withHead);
    const invalidated = this.store.invalidateStaleVerifications(taskId, candidateDigest);
    if (invalidated > 0) {
      this.store.setEvidence(taskId, "lastInvalidatedDigest", { candidateDigest, invalidated, at: now }, now);
    }
    return { candidateDigest, invalidated };
  }

  /**
   * Explicitly checks whether the latest verification for `taskId` is fresh
   * (non-stale, `accepted`) and matches `expectedCandidateDigest`.
   */
  hasFreshAcceptedVerification(taskId: string, expectedCandidateDigest: string): boolean {
    const verifications = this.store.listVerifications(taskId);
    const latest = verifications[0];
    if (!latest) return false;
    return !latest.stale && latest.result === "accepted" && latest.candidateDigest === expectedCandidateDigest;
  }

  /**
   * Commits the outcome of a declarative `VerificationPipeline` run for a
   * `repo_delivery` task. Rejects stale candidates, parks `waiting_external`
   * tasks in `waiting_external_ci` with a 0-Token outbox poller job, and only
   * transitions to `completed` when all verification steps pass on the exact
   * current candidate commits.
   */
  recordPipelineVerification(
    taskId: string,
    taskRunId: string,
    outcome: PipelineOutcome,
    options: { finalFailure?: boolean; ciPollDelayMs?: number } = {},
  ): { status: string; findings: VerificationFinding[] } {
    const view = this.store.view(taskId);
    if (!view) throw new TaskNotFoundError(`task ${taskId} not found`);
    if (view.task.status === "stopping" || view.task.status === "stopped") {
      const now = toIso(this.now());
      this.store.setEvidence(taskId, "lateCandidate", { outcome, runId: taskRunId, status: view.task.status, observedAt: now }, now);
      return { status: "ignored_after_stop", findings: [] };
    }

    const now = toIso(this.now());
    const currentRepos = view.task.repos.filter((r): r is RepoDeliveryState & { headSha: string } => typeof r.headSha === "string" && r.headSha !== "");
    const currentDigest = currentRepos.length > 0 ? computeRepoCandidateDigest(currentRepos) : outcome.candidateDigest;
    const isStaleCandidate = outcome.candidateDigest !== currentDigest;
    const effectiveStatus = isStaleCandidate ? "rejected" : outcome.status;
    const effectiveFindings: VerificationFinding[] = isStaleCandidate
      ? [
          ...outcome.findings,
          {
            code: "stale_candidate",
            detail: `verification bound to ${outcome.candidateDigest.slice(0, 12)} but current candidate is ${currentDigest.slice(0, 12)}`,
          },
        ]
      : outcome.findings;

    const seal: TaskResult | null =
      effectiveStatus === "accepted"
        ? {
            verdict: "verified",
            inputDigest: view.task.inputDigest,
            verifierVersion: outcome.verifierVersion,
            candidateDigest: outcome.candidateDigest,
            boundCommits: outcome.boundCommits,
            steps: outcome.steps.map((s) => ({
              stepName: s.stepName,
              stepType: s.stepType,
              status: s.status,
              exitCode: s.exitCode ?? null,
              boundCommits: s.boundCommits,
            })),
            productionDeployed: false,
          }
        : null;

    const eventType =
      effectiveStatus === "accepted"
        ? "task_completed"
        : effectiveStatus === "waiting_external"
          ? "task_waiting"
          : options.finalFailure
            ? "task_failed"
            : "verification_recorded";

    const pollRunAfter = toIso(new Date(this.now().getTime() + (options.ciPollDelayMs ?? 2_000)));
    const nonce = newId().slice(0, 8);

    this.writer.commit({
      taskId,
      type: eventType,
      payload:
        effectiveStatus === "accepted"
          ? { result: seal }
          : effectiveStatus === "waiting_external"
            ? { waitingReason: "waiting_external_ci", boundCommits: outcome.boundCommits, findings: effectiveFindings }
            : { status: effectiveStatus, candidateDigest: outcome.candidateDigest, findings: effectiveFindings },
      options: {
        idempotencyKey: `pipeline:${effectiveStatus}:${outcome.candidateDigest.slice(0, 12)}:${nonce}`,
        now,
        enqueue:
          effectiveStatus === "waiting_external"
            ? [{ kind: JOB_POLL_CI, dedupeKey: `ci:${outcome.candidateDigest.slice(0, 12)}:${nonce}`, runAfter: pollRunAfter }]
            : [],
      },
      project: () => {
        this.store.invalidateStaleVerifications(taskId, currentDigest);
        this.store.recordCandidate({
          taskId,
          taskRunId,
          briefVersion: view.briefVersion,
          candidate: { boundCommits: outcome.boundCommits, steps: outcome.steps },
          candidateDigest: outcome.candidateDigest,
          verification: {
            result: effectiveStatus,
            verifierVersion: outcome.verifierVersion,
            findings: effectiveFindings,
            environment: "isolated-worktree",
          },
          now,
        });
        if (isStaleCandidate) {
          this.store.invalidateStaleVerifications(taskId, currentDigest);
        }
        this.store.setEvidence(
          taskId,
          "lastVerification",
          { result: effectiveStatus, verifierVersion: outcome.verifierVersion, candidateDigest: outcome.candidateDigest, boundCommits: outcome.boundCommits, at: now },
          now,
        );
        if (effectiveStatus === "accepted" && seal) {
          this.store.setResult(taskId, seal, now);
          this.store.setStatus(taskId, "completed", null, now);
          this.store.setOperationStatus(`${taskId}:dispatch`, "done", { result: "completed", candidateDigest: outcome.candidateDigest }, now);
          this.store.enqueueNotification(taskId, "task_completed", seal, now);
        } else if (effectiveStatus === "waiting_external") {
          this.store.setStatus(taskId, "waiting", "waiting_external_ci", now);
          this.store.enqueueNotification(taskId, "waiting_external_ci", { boundCommits: outcome.boundCommits }, now);
        } else if (options.finalFailure) {
          const reason = effectiveFindings.map((f) => `${f.code}: ${f.detail}`).join("; ") || "verification failed";
          this.store.setStatus(taskId, "failed", null, now);
          this.store.setFailure(taskId, reason, now);
          this.store.setOperationStatus(`${taskId}:dispatch`, "done", { result: "failed", reason }, now);
          this.store.enqueueNotification(taskId, "task_failed", { findings: effectiveFindings }, now);
        }
      },
    });
    return { status: effectiveStatus, findings: effectiveFindings };
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
        this.inboxStore.resolve(taskId, "decision_required", now);
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
    // Deliberately do NOT enqueue a dispatch job here; execution must remain
    // paused until the user explicitly resolves the red-line decision.
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
    if (view.task.status !== "waiting" || view.task.waitingReason !== "needs_human_decision") {
      throw new TaskConflictError("invalid_state", `task ${taskId} is not waiting for a human authorization decision`);
    }
    const pendingCard = this.inboxStore.get(taskId, "decision_required");
    if (pendingCard?.action && pendingCard.action !== input.action) {
      throw new InvalidInputError(`pending decision is for action ${pendingCard.action}, not ${input.action}`);
    }
    const now = toIso(this.now());
    const nextGrantVersion = view.authorizationVersion + 1;
    let grantVersion = view.authorizationVersion;
    this.writer.commit({
      taskId,
      type: "run_observed",
      payload: { authorization: { action: input.action, approved: input.approved, grantVersion: input.approved ? nextGrantVersion : view.authorizationVersion } },
      options: {
        idempotencyKey: `decision-resolved:${input.action}:${nextGrantVersion}:${input.approved}`,
        now,
        enqueue: input.approved ? [{ kind: JOB_DISPATCH, dedupeKey: `resume:${nextGrantVersion}`, runAfter: now }] : [],
      },
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

  /** Pending proposals for one task so the UI can render Amendment Diff cards. */
  listProposals(taskId: string): Proposal[] {
    const task = this.store.get(taskId);
    if (!task) throw new TaskNotFoundError(`task ${taskId} not found`);
    return this.proposalStore.listPending(taskId);
  }

  /** Current brief requirements for drafting diff proposals. */
  getBrief(taskId: string): BriefRequirements {
    const view = this.store.view(taskId);
    if (!view) throw new TaskNotFoundError(`task ${taskId} not found`);
    return view.brief;
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
