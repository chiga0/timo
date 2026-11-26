/**
 * Event vocabulary. Types are lowercase so they read naturally in logs and
 * JSON; only the three attention-firewall types in `ATTENTION_TYPES` may ever
 * reach the main conversation or the inbox (architecture "严格 3 枚举事件穿透").
 */
export const EVENT_TYPES = [
  "task_created",
  "dispatch_started",
  "run_observed",
  "task_waiting",
  "verification_recorded",
  "task_completed",
  "task_failed",
  "task_amended",
  "task_stopping",
  "task_stopped",
  "watchdog_signal",
  "decision_required",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * The only types allowed through the attention firewall (docs/architecture.md,
 * "严格 3 枚举事件穿透"). A first-level `watchdog_signal` is deliberately NOT in
 * this set: it wakes the chief-of-staff triage (Sprint 5), and only that triage
 * can escalate to `decision_required` or `task_blocked_final`.
 */
export const ATTENTION_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "decision_required",
  "task_completed",
  "task_failed",
]);

export function isAttentionEvent(type: EventType): boolean {
  return ATTENTION_TYPES.has(type);
}

export interface TaskEvent<T = unknown> {
  seq: number;
  eventId: string;
  taskId: string;
  type: EventType;
  payload: T;
  idempotencyKey: string;
  createdAt: string;
}
