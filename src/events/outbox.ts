import { newId, toIso } from "../util.js";
import type { Database } from "../store/database.js";

export type JobStatus = "pending" | "leased" | "done" | "dead";

export interface OutboxJob {
  jobId: string;
  taskId: string;
  kind: string;
  status: JobStatus;
  runAfter: string;
  attempts: number;
  maxAttempts: number;
  leaseUntil: string | null;
  leaseOwner: string | null;
  lastError: string | null;
  payload: unknown;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueJobInput {
  taskId: string;
  kind: string;
  payload?: unknown;
  /** Same (taskId, kind, dedupeKey) is one job; enqueueing again is a no-op. */
  dedupeKey: string;
  runAfter?: string;
  maxAttempts?: number;
  now?: string;
}

export interface ClaimOptions {
  /** Identifies the claiming process; only its own leases may be renewed. */
  owner: string;
  now?: string;
  limit?: number;
  /** How long the claim stays valid before another pass may steal it. */
  leaseMs?: number;
  kinds?: string[];
}

/**
 * Durable job queue. Online work is still triggered from the event bus, but every
 * job also lives here, so a crash, a restart or a sleeping laptop resumes from
 * the database. Claims are leases: a job leased by a dead process becomes
 * claimable again once `lease_until` passes.
 */
export class Outbox {
  constructor(private readonly db: Database) {}

  enqueue(input: EnqueueJobInput): OutboxJob {
    const now = input.now ?? toIso(new Date());
    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM outbox_jobs WHERE task_id = ? AND kind = ? AND dedupe_key = ?")
        .get(input.taskId, input.kind, input.dedupeKey) as JobRow | undefined;
      if (existing) {
        // A done job stays done; a dead one is revived only if the caller asks
        // for another attempt by resetting it explicitly.
        if (existing.status === "pending" || existing.status === "leased") {
          const runAfter = input.runAfter && input.runAfter < existing.run_after ? input.runAfter : existing.run_after;
          if (runAfter !== existing.run_after) {
            this.db.prepare("UPDATE outbox_jobs SET run_after = ?, updated_at = ? WHERE job_id = ?").run(runAfter, now, existing.job_id);
          }
        }
        return this.get(existing.job_id)!;
      }
      const jobId = newId();
      this.db
        .prepare(
          `INSERT INTO outbox_jobs (job_id, task_id, kind, status, run_after, attempts, max_attempts, lease_until, lease_owner,
             last_error, payload_json, dedupe_key, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, 0, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          input.taskId,
          input.kind,
          input.runAfter ?? now,
          input.maxAttempts ?? 5,
          JSON.stringify(input.payload ?? null),
          input.dedupeKey,
          now,
          now,
        );
      return this.get(jobId)!;
    });
  }

  get(jobId: string): OutboxJob | undefined {
    const row = this.db.prepare("SELECT * FROM outbox_jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
    return row ? toJob(row) : undefined;
  }

  byTask(taskId: string): OutboxJob[] {
    const rows = this.db.prepare("SELECT * FROM outbox_jobs WHERE task_id = ? ORDER BY created_at").all(taskId) as JobRow[];
    return rows.map(toJob);
  }

  /** Requeues a finished job so a rescheduled run can happen (e.g. after amend). */
  requeue(jobId: string, runAfter: string, now = toIso(new Date())): void {
    this.db
      .prepare("UPDATE outbox_jobs SET status = 'pending', run_after = ?, lease_until = NULL, lease_owner = NULL, updated_at = ? WHERE job_id = ?")
      .run(runAfter, now, jobId);
  }

  /**
   * Claims due jobs. Expired leases (owner died) are claimable again, which is
   * what makes an interrupted pass recoverable without manual intervention.
   */
  claim(options: ClaimOptions): OutboxJob[] {
    const now = options.now ?? toIso(new Date());
    const leaseMs = options.leaseMs ?? 60_000;
    const limit = options.limit ?? 8;
    const leaseUntil = toIso(new Date(Date.parse(now) + leaseMs));
    return this.db.transaction(() => {
      const kindFilter = options.kinds && options.kinds.length > 0 ? `AND kind IN (${options.kinds.map(() => "?").join(", ")})` : "";
      const rows = this.db
        .prepare(
          `SELECT * FROM outbox_jobs
           WHERE status IN ('pending', 'leased')
             AND attempts < max_attempts
             AND (status = 'pending' AND run_after <= ? OR status = 'leased' AND lease_until <= ?)
             ${kindFilter}
           ORDER BY run_after, created_at
           LIMIT ?`,
        )
        .all(now, now, ...(options.kinds ?? []), limit) as JobRow[];
      const claimed: OutboxJob[] = [];
      for (const row of rows) {
        const result = this.db
          .prepare(
            `UPDATE outbox_jobs SET status = 'leased', attempts = attempts + 1, lease_until = ?, lease_owner = ?, updated_at = ?
             WHERE job_id = ? AND (lease_owner IS NULL OR lease_until <= ? OR lease_owner = ?)`,
          )
          .run(leaseUntil, options.owner, now, row.job_id, now, options.owner);
        // A concurrent claim in another process wins: skip, it is not ours.
        if (Number(result.changes) === 0) continue;
        claimed.push(this.get(row.job_id)!);
      }
      return claimed;
    });
  }

  /** Marks a claimed job done. Attempts stay as history. */
  complete(jobId: string, now = toIso(new Date())): void {
    this.db.prepare("UPDATE outbox_jobs SET status = 'done', lease_until = NULL, lease_owner = NULL, last_error = NULL, updated_at = ? WHERE job_id = ?").run(now, jobId);
  }

  /**
   * Returns a job to the queue with a backoff, or marks it dead once the attempt
   * budget is spent. Retrying forever would let one broken job starve the pool.
   */
  retry(jobId: string, error: string, backoffMs: number, now = toIso(new Date())): { status: JobStatus; runAfter: string } {
    return this.db.transaction(() => {
      const job = this.get(jobId);
      if (!job) throw new Error(`job ${jobId} not found`);
      if (job.attempts >= job.maxAttempts) {
        this.db
          .prepare("UPDATE outbox_jobs SET status = 'dead', last_error = ?, lease_until = NULL, lease_owner = NULL, updated_at = ? WHERE job_id = ?")
          .run(error, now, jobId);
        return { status: "dead" as const, runAfter: now };
      }
      const runAfter = toIso(new Date(Date.parse(now) + backoffMs));
      this.db
        .prepare(
          "UPDATE outbox_jobs SET status = 'pending', run_after = ?, lease_until = NULL, lease_owner = NULL, last_error = ?, updated_at = ? WHERE job_id = ?",
        )
        .run(runAfter, error, now, jobId);
      return { status: "pending" as const, runAfter };
    });
  }
}

interface JobRow {
  job_id: string;
  task_id: string;
  kind: string;
  status: JobStatus;
  run_after: string;
  attempts: number;
  max_attempts: number;
  lease_until: string | null;
  lease_owner: string | null;
  last_error: string | null;
  payload_json: string;
  dedupe_key: string;
  created_at: string;
  updated_at: string;
}

function toJob(row: JobRow): OutboxJob {
  return {
    jobId: row.job_id,
    taskId: row.task_id,
    kind: row.kind,
    status: row.status,
    runAfter: row.run_after,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseUntil: row.lease_until,
    leaseOwner: row.lease_owner,
    lastError: row.last_error,
    payload: JSON.parse(row.payload_json) as unknown,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
