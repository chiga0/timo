import { newId, toIso } from "../util.js";
import type { Database } from "../store/database.js";
import type { TaskEvent, EventType } from "./types.js";

export interface AppendEventInput {
  taskId: string;
  type: EventType;
  payload: unknown;
  /**
   * Stable key for "this fact happened once". A second append with the same
   * (taskId, idempotencyKey) is a no-op that returns the original event, so a
   * retried transaction or a replayed recovery cannot double-count.
   */
  idempotencyKey: string;
  now?: string;
}

export interface LedgerReader {
  afterSeq(seq: number, limit: number): TaskEvent[];
  forTask(taskId: string, afterSeq: number, limit: number): TaskEvent[];
}

/**
 * Append-only business facts. Every business state transition appends here in
 * the same `BEGIN IMMEDIATE` transaction that updates the materialised `tasks`
 * row and enqueues outbox jobs. Broadcast to subscribers happens only after the
 * transaction commits, so an uncommitted or rolled back event is never seen.
 */
export class EventLedger {
  constructor(private readonly db: Database) {}

  /**
   * Appends one event. Must be called inside `db.transaction()` when it
   * accompanies a projection update; calling it standalone still commits the
   * event atomically on its own.
   */
  append(input: AppendEventInput): TaskEvent {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT seq, event_id, type, payload_json, created_at FROM task_events WHERE task_id = ? AND idempotency_key = ?")
        .get(input.taskId, input.idempotencyKey) as
        | { seq: number; event_id: string; type: EventType; payload_json: string; created_at: string }
        | undefined;
      if (existing) {
        return {
          seq: Number(existing.seq),
          eventId: existing.event_id,
          taskId: input.taskId,
          type: existing.type,
          payload: JSON.parse(existing.payload_json) as unknown,
          idempotencyKey: input.idempotencyKey,
          createdAt: existing.created_at,
        };
      }
      const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM task_events").get() as { seq: number };
      const seq = Number(row.seq) + 1;
      const eventId = newId();
      const createdAt = input.now ?? toIso(new Date());
      this.db
        .prepare(
          `INSERT INTO task_events (seq, event_id, task_id, type, payload_json, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(seq, eventId, input.taskId, input.type, JSON.stringify(input.payload ?? null), input.idempotencyKey, createdAt);
      return { seq, eventId, taskId: input.taskId, type: input.type, payload: input.payload ?? null, idempotencyKey: input.idempotencyKey, createdAt };
    });
  }

  /** Global replay used by SSE `afterSeq` resumption. */
  afterSeq(seq: number, limit = 500): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT seq, event_id, task_id, type, payload_json, idempotency_key, created_at FROM task_events WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(seq, limit) as EventRow[];
    return rows.map(toEvent);
  }

  forTask(taskId: string, afterSeq = 0, limit = 500): TaskEvent[] {
    const rows = this.db
      .prepare(
        `SELECT seq, event_id, task_id, type, payload_json, idempotency_key, created_at
         FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(taskId, afterSeq, limit) as EventRow[];
    return rows.map(toEvent);
  }

  latestSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM task_events").get() as { seq: number };
    return Number(row.seq);
  }
}

interface EventRow {
  seq: number;
  event_id: string;
  task_id: string;
  type: EventType;
  payload_json: string;
  idempotency_key: string;
  created_at: string;
}

function toEvent(row: EventRow): TaskEvent {
  return {
    seq: Number(row.seq),
    eventId: row.event_id,
    taskId: row.task_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}
