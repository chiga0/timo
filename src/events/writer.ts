import type { Database } from "../store/database.js";
import { EventLedger } from "./ledger.js";
import { TypedEventBus } from "./bus.js";
import { Outbox } from "./outbox.js";
import type { TaskEvent, EventType } from "./types.js";

/** Job kinds the scheduler understands. Kept as constants to avoid typos. */
export const JOB_DISPATCH = "dispatch";
export const JOB_RECONCILE = "reconcile";
export const JOB_STOP = "stop";
export const JOB_POLL_CI = "poll_ci";

export interface TransitionOptions {
  /** Stable fact key; replays and retries with the same key are no-ops. */
  idempotencyKey: string;
  now?: string;
  /** Extra jobs to enqueue inside the same transaction. */
  enqueue?: Array<{ kind: string; dedupeKey: string; payload?: unknown; runAfter?: string; maxAttempts?: number }>;
}

/**
 * One place that commits business transitions. The event, the projection and the
 * follow-up jobs go in one `BEGIN IMMEDIATE` transaction; the broadcast happens
 * strictly after commit so a rollback can never leak a phantom event to
 * subscribers or to the Web SSE stream.
 */
export class TransitionWriter {
  readonly ledger: EventLedger;
  readonly outbox: Outbox;

  constructor(
    private readonly db: Database,
    private readonly bus: TypedEventBus,
    private readonly onError?: (error: unknown) => void,
  ) {
    this.ledger = new EventLedger(db);
    this.outbox = new Outbox(db);
  }

  /**
   * Applies `project` (materialised row updates) plus an event plus optional
   * jobs atomically, then publishes the event to the bus.
   */
  commit(input: {
    taskId: string;
    type: EventType;
    payload: unknown;
    options: TransitionOptions;
    project?: () => void;
  }): TaskEvent {
    const event = this.db.transaction(() => {
      input.project?.();
      const appended = this.ledger.append({
        taskId: input.taskId,
        type: input.type,
        payload: input.payload,
        idempotencyKey: input.options.idempotencyKey,
        now: input.options.now,
      });
      for (const job of input.options.enqueue ?? []) {
        this.outbox.enqueue({
          taskId: input.taskId,
          kind: job.kind,
          dedupeKey: job.dedupeKey,
          payload: job.payload,
          runAfter: job.runAfter,
          maxAttempts: job.maxAttempts,
          now: input.options.now,
        });
      }
      return appended;
    });
    // Publish outside the transaction: subscribers may read or enqueue again.
    this.bus.publish(event, this.onError);
    return event;
  }
}
