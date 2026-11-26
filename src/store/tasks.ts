import type { Database } from "./database.js";
import type { SseCandidate, SseIncident, SseVerdict, Finding } from "../sse/contract.js";

export type TaskStatus =
  | "accepted"
  | "running"
  | "waiting"
  | "verifying"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";

/** Terminal states never advance again. */
export function isTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

/** States where a stop request is meaningful. */
export function canStop(status: TaskStatus): boolean {
  return status === "accepted" || status === "running" || status === "waiting" || status === "verifying";
}

export type WaitingReason =
  | "t3_unavailable"
  | "t3_auth"
  | "input_incomplete"
  | "effect_unknown"
  | "retrying"
  | "budget_exhausted";

export interface ResultIncident {
  connectionId: string;
  disconnectLine: number;
  reconnectLine: number | null;
}

export interface TaskResult {
  verdict: SseVerdict;
  incidents: ResultIncident[];
  inputDigest: string;
  verifierVersion: string;
}

export interface TaskRow {
  taskId: string;
  requestId: string;
  requestDigest: string;
  status: TaskStatus;
  waitingReason: WaitingReason | null;
  inputDigest: string;
  artifactPath: string;
  threadId: string | null;
  runId: string | null;
  result: TaskResult | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BriefRequirements {
  goal: string;
  must: string[];
  mustNot: string[];
  evidence: string[];
}

export interface Grant {
  action: string;
  resource: string;
  environment: string | null;
  identity: string | null;
  expiresAt: string | null;
}

export interface TaskRecordView {
  task: TaskRow;
  briefVersion: number;
  brief: BriefRequirements;
  authorizationVersion: number;
  grants: Grant[];
  execution: {
    executionId: string;
    generation: number;
    environment: string;
    providerInstanceId: string;
    model: string;
  } | null;
  runs: Array<{ threadId: string; runId: string; status: string; lastObservedAt: string }>;
  verification: {
    result: string;
    verifierVersion: string;
    findings: Finding[];
    createdAt: string;
  } | null;
}

export interface NewTaskInput {
  taskId: string;
  requestId: string;
  requestDigest: string;
  inputDigest: string;
  artifactPath: string;
  requestText: string;
  brief: BriefRequirements;
  grants: Grant[];
  environment: string;
  providerInstanceId: string;
  model: string;
  now: string;
}

export class RequestConflictError extends Error {
  override readonly name = "RequestConflictError";
}

interface TaskDbRow {
  task_id: string;
  request_id: string;
  request_digest: string;
  status: TaskStatus;
  waiting_reason: WaitingReason | null;
  input_digest: string;
  artifact_path: string;
  thread_id: string | null;
  run_id: string | null;
  result_json: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

function toTaskRow(row: TaskDbRow): TaskRow {
  return {
    taskId: row.task_id,
    requestId: row.request_id,
    requestDigest: row.request_digest,
    status: row.status,
    waitingReason: row.waiting_reason,
    inputDigest: row.input_digest,
    artifactPath: row.artifact_path,
    threadId: row.thread_id,
    runId: row.run_id,
    result: row.result_json ? (JSON.parse(row.result_json) as TaskResult) : null,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskStore {
  constructor(readonly db: Database) {}

  /**
   * Persists the task, its first brief and grant revision, execution generation,
   * dispatch intent and status snapshot in one transaction. The dispatch intent
   * is what the background worker later claims.
   */
  createTask(input: NewTaskInput): { task: TaskRow; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.findByRequestId(input.requestId);
      if (existing) {
        if (existing.requestDigest !== input.requestDigest) throw new RequestConflictError(`request ${input.requestId} was used with different content`);
        return { task: existing, created: false };
      }
      this.db
        .prepare(
          `INSERT INTO tasks (task_id, request_id, request_digest, status, waiting_reason, input_digest, artifact_path,
             thread_id, run_id, result_json, failure_reason, created_at, updated_at)
           VALUES (?, ?, ?, 'accepted', NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(input.taskId, input.requestId, input.requestDigest, input.inputDigest, input.artifactPath, input.now, input.now);
      this.db
        .prepare("INSERT INTO brief_revisions (task_id, version, request_text, requirements_json, created_at) VALUES (?, 1, ?, ?, ?)")
        .run(input.taskId, input.requestText, JSON.stringify(input.brief), input.now);
      this.db
        .prepare("INSERT INTO authorization_snapshots (task_id, version, grants_json, created_at) VALUES (?, 1, ?, ?)")
        .run(input.taskId, JSON.stringify(input.grants), input.now);
      this.db
        .prepare(
          `INSERT INTO executions (execution_id, task_id, generation, environment, provider_instance_id, model, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(`${input.taskId}:g1`, input.taskId, input.environment, input.providerInstanceId, input.model, input.now);
      this.db
        .prepare(
          `INSERT INTO operations (operation_id, task_id, kind, status, client_request_id, payload_json, receipt_json, created_at, updated_at)
           VALUES (?, ?, 'dispatch', 'pending', ?, ?, NULL, ?, ?)`,
        )
        .run(`${input.taskId}:dispatch`, input.taskId, stableRequestId(`${input.taskId}:launch`), JSON.stringify({ inputDigest: input.inputDigest }), input.now, input.now);
      return { task: this.get(input.taskId)!, created: true };
    });
  }

  get(taskId: string): TaskRow | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as TaskDbRow | undefined;
    return row ? toTaskRow(row) : undefined;
  }

  findByRequestId(requestId: string): TaskRow | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE request_id = ?").get(requestId) as TaskDbRow | undefined;
    return row ? toTaskRow(row) : undefined;
  }

  view(taskId: string): TaskRecordView | undefined {
    const task = this.get(taskId);
    if (!task) return undefined;
    const briefRow = this.db
      .prepare("SELECT version, request_text, requirements_json FROM brief_revisions WHERE task_id = ? ORDER BY version DESC LIMIT 1")
      .get(taskId) as { version: number; request_text: string; requirements_json: string } | undefined;
    const grantRow = this.db
      .prepare("SELECT version, grants_json FROM authorization_snapshots WHERE task_id = ? ORDER BY version DESC LIMIT 1")
      .get(taskId) as { version: number; grants_json: string } | undefined;
    const executionRow = this.db
      .prepare("SELECT execution_id, generation, environment, provider_instance_id, model FROM executions WHERE task_id = ? ORDER BY generation DESC LIMIT 1")
      .get(taskId) as
      | { execution_id: string; generation: number; environment: string; provider_instance_id: string; model: string }
      | undefined;
    const runs = this.db
      .prepare("SELECT thread_id, run_id, run_status, last_observed_at FROM run_references WHERE task_id = ? ORDER BY last_observed_at")
      .all(taskId) as Array<{ thread_id: string; run_id: string; run_status: string; last_observed_at: string }>;
    const verificationRow = this.db
      .prepare(
        `SELECT v.result, v.verifier_version, v.findings_json, v.created_at FROM verifications v
         JOIN candidates c ON c.candidate_id = v.candidate_id
         WHERE c.task_id = ? ORDER BY v.created_at DESC LIMIT 1`,
      )
      .get(taskId) as { result: string; verifier_version: string; findings_json: string; created_at: string } | undefined;

    return {
      task,
      briefVersion: briefRow?.version ?? 0,
      brief: briefRow ? (JSON.parse(briefRow.requirements_json) as BriefRequirements) : { goal: "", must: [], mustNot: [], evidence: [] },
      authorizationVersion: grantRow?.version ?? 0,
      grants: grantRow ? (JSON.parse(grantRow.grants_json) as Grant[]) : [],
      execution: executionRow
        ? {
            executionId: executionRow.execution_id,
            generation: executionRow.generation,
            environment: executionRow.environment,
            providerInstanceId: executionRow.provider_instance_id,
            model: executionRow.model,
          }
        : null,
      runs: runs.map((run) => ({ threadId: run.thread_id, runId: run.run_id, status: run.run_status, lastObservedAt: run.last_observed_at })),
      verification: verificationRow
        ? {
            result: verificationRow.result,
            verifierVersion: verificationRow.verifier_version,
            findings: JSON.parse(verificationRow.findings_json) as Finding[],
            createdAt: verificationRow.created_at,
          }
        : null,
    };
  }

  listPendingDispatches(): Array<{ taskId: string; operationId: string; updatedAt: string }> {
    const rows = this.db
      .prepare("SELECT task_id, operation_id, updated_at FROM operations WHERE kind = 'dispatch' AND status IN ('pending', 'in_flight') ORDER BY created_at")
      .all() as Array<{ task_id: string; operation_id: string; updated_at: string }>;
    return rows.map((row) => ({ taskId: row.task_id, operationId: row.operation_id, updatedAt: row.updated_at }));
  }

  setStatus(taskId: string, status: TaskStatus, waitingReason: WaitingReason | null, now: string): void {
    this.db.prepare("UPDATE tasks SET status = ?, waiting_reason = ?, updated_at = ? WHERE task_id = ?").run(status, waitingReason, now, taskId);
  }

  setFailure(taskId: string, reason: string, now: string): void {
    this.db.prepare("UPDATE tasks SET failure_reason = ?, updated_at = ? WHERE task_id = ?").run(reason, now, taskId);
  }

  setThread(taskId: string, threadId: string, now: string): void {
    this.db.prepare("UPDATE tasks SET thread_id = ?, updated_at = ? WHERE task_id = ?").run(threadId, now, taskId);
  }

  setRun(taskId: string, runId: string, now: string): void {
    this.db.prepare("UPDATE tasks SET run_id = ?, updated_at = ? WHERE task_id = ?").run(runId, now, taskId);
  }

  setResult(taskId: string, result: TaskResult, now: string): void {
    this.db.prepare("UPDATE tasks SET result_json = ?, updated_at = ? WHERE task_id = ?").run(JSON.stringify(result), now, taskId);
  }

  executionFor(taskId: string): { executionId: string; environment: string; providerInstanceId: string; model: string } | undefined {
    const row = this.db
      .prepare("SELECT execution_id, environment, provider_instance_id, model FROM executions WHERE task_id = ? ORDER BY generation DESC LIMIT 1")
      .get(taskId) as { execution_id: string; environment: string; provider_instance_id: string; model: string } | undefined;
    return row
      ? { executionId: row.execution_id, environment: row.environment, providerInstanceId: row.provider_instance_id, model: row.model }
      : undefined;
  }

  getOperation(taskId: string, kind: string): OperationRow | undefined {
    const row = this.db.prepare("SELECT * FROM operations WHERE task_id = ? AND kind = ?").get(taskId, kind) as OperationDbRow | undefined;
    return row ? toOperationRow(row) : undefined;
  }

  setOperationStatus(operationId: string, status: OperationStatus, receipt: unknown, now: string): void {
    this.db
      .prepare("UPDATE operations SET status = ?, receipt_json = COALESCE(?, receipt_json), updated_at = ? WHERE operation_id = ?")
      .run(status, receipt === undefined ? null : JSON.stringify(receipt), now, operationId);
  }

  recordAttempt(attemptId: string, operationId: string, errorKind: string | null, receipt: unknown, now: string): void {
    this.db
      .prepare("INSERT INTO attempts (attempt_id, operation_id, error_kind, receipt_json, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(attemptId, operationId, errorKind, receipt === undefined ? null : JSON.stringify(receipt), now, now);
  }

  /**
   * Records the submitted candidate and its independent verification together,
   * so a crash never leaves a candidate without a verdict.
   */
  recordCandidate(input: {
    taskId: string;
    taskRunId: string;
    briefVersion: number;
    candidate: unknown;
    candidateDigest: string;
    verification: { result: string; verifierVersion: string; findings: Finding[]; environment: string | null };
    now: string;
  }): void {
    this.db.transaction(() => {
      const candidateId = `${input.taskId}:candidate:${input.candidateDigest.slice(0, 16)}`;
      // A candidate for an unknown or unpersisted run still needs a valid
      // reference; a local-only verdict uses a placeholder that never reaches T3.
      const executionRow = this.db
        .prepare("SELECT execution_id FROM executions WHERE task_id = ? ORDER BY generation LIMIT 1")
        .get(input.taskId) as { execution_id: string } | undefined;
      if (executionRow) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO run_references (run_reference_id, task_id, execution_id, thread_id, run_id, provider_instance_id, run_status, last_observed_at)
             VALUES (?, ?, ?, ?, ?, 'unknown', 'not_dispatched', ?)`,
          )
          .run(`${input.taskId}:local:${input.taskRunId}`, input.taskId, executionRow.execution_id, input.taskId, input.taskRunId, input.now);
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO candidates (candidate_id, task_id, run_id, form, body_json, digest, created_at)
           VALUES (?, ?, ?, 'json', ?, ?, ?)`,
        )
        .run(candidateId, input.taskId, input.taskRunId, JSON.stringify(input.candidate), input.candidateDigest, input.now);
      this.db
        .prepare(
          `INSERT INTO verifications (verification_id, candidate_id, brief_version, verifier_version, result, findings_json, environment, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `${candidateId}:v:${input.now}`,
          candidateId,
          input.briefVersion,
          input.verification.verifierVersion,
          input.verification.result,
          JSON.stringify(input.verification.findings),
          input.verification.environment,
          input.now,
        );
    });
  }

  upsertRunReference(input: { taskId: string; executionId: string; threadId: string; runId: string; providerInstanceId: string; status: string; now: string }): void {
    this.db
      .prepare(
        `INSERT INTO run_references (run_reference_id, task_id, execution_id, thread_id, run_id, provider_instance_id, run_status, last_observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id, run_id) DO UPDATE SET run_status = excluded.run_status, last_observed_at = excluded.last_observed_at`,
      )
      .run(
        `${input.threadId}:${input.runId}`,
        input.taskId,
        input.executionId,
        input.threadId,
        input.runId,
        input.providerInstanceId,
        input.status,
        input.now,
      );
  }

  setEvidence(taskId: string, name: string, value: unknown, now: string): void {
    this.db
      .prepare(
        `INSERT INTO evidence (task_id, name, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (task_id, name) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(taskId, name, JSON.stringify(value), now);
  }

  getEvidence<T>(taskId: string, name: string): T | undefined {
    const row = this.db.prepare("SELECT value_json FROM evidence WHERE task_id = ? AND name = ?").get(taskId, name) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }

  /**
   * Queues a notification. A task may enter the same waiting kind repeatedly, so
   * each attempt gets a unique `dedupe_key` derived from the occurrence counter;
   * `addressed` marks the entry as handled (the partial unique index only covers
   * unaddressed rows, so history never blocks a new entry).
   */
  enqueueNotification(taskId: string, kind: string, body: unknown, now: string, dedupeKey?: string): void {
    const seq = (this.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE task_id = ? AND kind = ?").get(taskId, kind) as { n: number }).n;
    const key = dedupeKey ?? String(Number(seq) + 1);
    this.db
      .prepare(
        `INSERT INTO notifications (notification_id, task_id, kind, body_json, created_at, delivered_at, dedupe_key)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(`${taskId}:${kind}:${key}:${now}`, taskId, kind, JSON.stringify(body), now, key);
  }

  undeliveredNotifications(taskId: string): Array<{ kind: string; body: unknown; dedupeKey: string }> {
    const rows = this.db
      .prepare("SELECT kind, body_json, dedupe_key FROM notifications WHERE task_id = ? AND delivered_at IS NULL ORDER BY created_at")
      .all(taskId) as Array<{ kind: string; body_json: string; dedupe_key: string }>;
    return rows.map((row) => ({ kind: row.kind, body: JSON.parse(row.body_json), dedupeKey: row.dedupe_key }));
  }

  /** Marks every undelivered notification of a task as delivered. */
  markNotificationsDelivered(taskId: string, now: string): number {
    const result = this.db
      .prepare("UPDATE notifications SET delivered_at = ? WHERE task_id = ? AND delivered_at IS NULL")
      .run(now, taskId);
    return Number(result.changes);
  }

  /**
   * Writes back the executor identity actually used by a dispatch. The execution
   * row starts as `pending`; the first successful launch binds it to the
   * provider instance and model the client really ran.
   */
  bindExecution(taskId: string, providerInstanceId: string, model: string, now: string): void {
    this.db
      .prepare(
        `UPDATE executions SET provider_instance_id = ?, model = ?
         WHERE task_id = ? AND generation = (SELECT MAX(generation) FROM executions WHERE task_id = ?)`,
      )
      .run(providerInstanceId, model, taskId, taskId);
    this.db.prepare("UPDATE tasks SET updated_at = ? WHERE task_id = ?").run(now, taskId);
  }

  /** Tasks whose external run exists but whose local state is not terminal yet. */
  listInflightTasks(): Array<{ taskId: string; threadId: string; runId: string; status: TaskStatus }> {
    const rows = this.db
      .prepare(
        `SELECT task_id, thread_id, run_id, status FROM tasks
         WHERE status IN ('running', 'waiting', 'verifying')
           AND thread_id IS NOT NULL AND run_id IS NOT NULL
           AND run_id NOT LIKE '%:local:%'
           AND run_id != 'none'
         ORDER BY updated_at`,
      )
      .all() as Array<{ task_id: string; thread_id: string; run_id: string; status: TaskStatus }>;
    return rows.map((row) => ({ taskId: row.task_id, threadId: row.thread_id, runId: row.run_id, status: row.status }));
  }

  /** Records a completed brief amendment as a new immutable revision. */
  appendBriefRevision(taskId: string, requestText: string, brief: BriefRequirements, now: string): number {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM brief_revisions WHERE task_id = ?")
        .get(taskId) as { version: number };
      const version = Number(row.version) + 1;
      this.db
        .prepare("INSERT INTO brief_revisions (task_id, version, request_text, requirements_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(taskId, version, requestText, JSON.stringify(brief), now);
      this.db.prepare("UPDATE tasks SET updated_at = ? WHERE task_id = ?").run(now, taskId);
      return version;
    });
  }

  currentBriefVersion(taskId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM brief_revisions WHERE task_id = ?")
      .get(taskId) as { version: number };
    return Number(row.version);
  }

  currentBrief(taskId: string): BriefRequirements | undefined {
    const row = this.db
      .prepare("SELECT requirements_json FROM brief_revisions WHERE task_id = ? ORDER BY version DESC LIMIT 1")
      .get(taskId) as { requirements_json: string } | undefined;
    return row ? (JSON.parse(row.requirements_json) as BriefRequirements) : undefined;
  }

  latestRequestText(taskId: string): string {
    const row = this.db
      .prepare("SELECT request_text FROM brief_revisions WHERE task_id = ? ORDER BY version DESC LIMIT 1")
      .get(taskId) as { request_text: string } | undefined;
    return row?.request_text ?? "";
  }

  /** All tasks, newest first, with the fields the task list needs. */
  listTasks(limit = 200, status?: string): TaskRow[] {
    const rows = status
      ? (this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit) as TaskDbRow[])
      : (this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit) as TaskDbRow[]);
    return rows.map(toTaskRow);
  }

  /** Marks every non-terminal execution generation as revoked for a stopped task. */
  revokeExecutions(taskId: string, now: string): void {
    this.db.prepare("UPDATE executions SET revoked_at = ? WHERE task_id = ? AND revoked_at IS NULL").run(now, taskId);
  }

  executionReachable(taskId: string): boolean {
    const row = this.db
      .prepare("SELECT revoked_at FROM executions WHERE task_id = ? ORDER BY generation DESC LIMIT 1")
      .get(taskId) as { revoked_at: string | null } | undefined;
    return row ? row.revoked_at === null : false;
  }
}

export type OperationStatus = "pending" | "in_flight" | "done" | "failed" | "unknown";

export interface OperationRow {
  operationId: string;
  taskId: string;
  kind: string;
  status: OperationStatus;
  clientRequestId: string;
  payload: Record<string, unknown>;
  receipt: unknown;
}

interface OperationDbRow {
  operation_id: string;
  task_id: string;
  kind: string;
  status: OperationStatus;
  client_request_id: string;
  payload_json: string;
  receipt_json: string | null;
}

function toOperationRow(row: OperationDbRow): OperationRow {
  return {
    operationId: row.operation_id,
    taskId: row.task_id,
    kind: row.kind,
    status: row.status,
    clientRequestId: row.client_request_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
  };
}

export function stableRequestId(seed: string): string {
  // T3 dedupes on clientRequestId; the seed is stable per task so a retried
  // process reuses the same key within one OAuth authorization scope.
  return seed.replace(/[^A-Za-z0-9:_-]/g, "-").slice(0, 120);
}

export function resultFromExpected(digest: string, verifierVersion: string, expected: { verdict: SseVerdict; incidents: SseIncident[] }): TaskResult {
  return { verdict: expected.verdict, incidents: expected.incidents, inputDigest: digest, verifierVersion };
}

export interface CandidateSubmission {
  candidate: SseCandidate;
}
