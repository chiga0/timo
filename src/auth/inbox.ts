import { newId, toIso } from "../util.js";
import type { Database } from "../store/database.js";
import { isAttentionEvent, type EventType } from "../events/types.js";

export type DecisionKey = "decision_required" | "delivery_verified" | "task_blocked_final";

export interface InboxItem {
  taskId: string;
  decisionKey: DecisionKey;
  title: string;
  summary: string;
  options: string[];
  createdAt: string;
  updatedAt: string;
}

const KEY_BY_EVENT: Partial<Record<EventType, DecisionKey>> = {
  task_completed: "delivery_verified",
  task_failed: "task_blocked_final",
  decision_required: "decision_required",
};

/**
 * Attention-firewall projection. Only the three permitted event classes may
 * become inbox entries; everything else (tool logs, retries, auto-grants) is
 * structurally impossible to project here.
 *
 * Each entry is keyed by `(taskId, decisionKey)` and upserted in place, so a task
 * that updates its pending decision ten times still has exactly one card.
 */
export class Inbox {
  constructor(private readonly db: Database) {}

  /**
   * Projects a committed event into the inbox. Returns true when an entry was
   * created or updated, false when the event is not attention-worthy.
   */
  project(event: { taskId: string; type: EventType; payload: unknown; createdAt: string }): boolean {
    if (!isAttentionEvent(event.type)) return false;
    const decisionKey = KEY_BY_EVENT[event.type];
    if (!decisionKey) return false;
    const body = asRecord(event.payload);
    const title = titleFor(decisionKey, event.type);
    const summary = typeof body.detail === "string" ? body.detail : typeof body.reason === "string" ? body.reason : title;
    const options = Array.isArray(body.options) ? body.options.filter((item): item is string => typeof item === "string") : defaultOptions(decisionKey);
    this.upsert({ taskId: event.taskId, decisionKey, title, summary, options, now: event.createdAt });
    return true;
  }

  /** Idempotent in-place upsert; the card identity never changes. */
  upsert(input: { taskId: string; decisionKey: DecisionKey; title: string; summary: string; options: string[]; now?: string }): InboxItem {
    const now = input.now ?? toIso(new Date());
    return this.db.transaction(() => {
      const existing = this.get(input.taskId, input.decisionKey);
      if (existing) {
        // Same card, refreshed content: address (update) rather than append.
        this.db
          .prepare("UPDATE inbox_items SET title = ?, summary = ?, options_json = ?, updated_at = ? WHERE item_id = ?")
          .run(input.title, input.summary, JSON.stringify(input.options), now, `${input.taskId}:${input.decisionKey}`);
        return this.get(input.taskId, input.decisionKey)!;
      }
      this.db
        .prepare(
          `INSERT INTO inbox_items (item_id, task_id, decision_key, title, summary, options_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(`${input.taskId}:${input.decisionKey}`, input.taskId, input.decisionKey, input.title, input.summary, JSON.stringify(input.options), now, now);
      return this.get(input.taskId, input.decisionKey)!;
    });
  }

  get(taskId: string, decisionKey: DecisionKey): InboxItem | undefined {
    const row = this.db.prepare("SELECT * FROM inbox_items WHERE item_id = ?").get(`${taskId}:${decisionKey}`) as InboxRow | undefined;
    return row ? toItem(row) : undefined;
  }

  /** Current inbox, newest activity first. Never contains process telemetry. */
  list(limit = 100): InboxItem[] {
    const rows = this.db.prepare("SELECT * FROM inbox_items ORDER BY updated_at DESC LIMIT ?").all(limit) as InboxRow[];
    return rows.map(toItem);
  }

  /** Clears a card once the underlying decision is resolved. */
  resolve(taskId: string, decisionKey: DecisionKey, now = toIso(new Date())): boolean {
    const result = this.db.prepare("DELETE FROM inbox_items WHERE item_id = ?").run(`${taskId}:${decisionKey}`);
    void now;
    return Number(result.changes) > 0;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM inbox_items").get() as { n: number };
    return Number(row.n);
  }
}

interface InboxRow {
  item_id: string;
  task_id: string;
  decision_key: DecisionKey;
  title: string;
  summary: string;
  options_json: string;
  created_at: string;
  updated_at: string;
}

function toItem(row: InboxRow): InboxItem {
  return {
    taskId: row.task_id,
    decisionKey: row.decision_key,
    title: row.title,
    summary: row.summary,
    options: JSON.parse(row.options_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function titleFor(key: DecisionKey, type: EventType): string {
  if (key === "delivery_verified") return "交付已验证";
  if (key === "task_blocked_final") return `任务阻塞（${type}）`;
  return "需要你的决定";
}

function defaultOptions(key: DecisionKey): string[] {
  if (key === "decision_required") return ["批准", "拒绝"];
  if (key === "task_blocked_final") return ["重试", "停止"];
  return ["查看交付"];
}

/** Stable id helper so callers do not hand-build the composite key. */
export function inboxItemId(taskId: string, decisionKey: DecisionKey): string {
  return `${taskId}:${decisionKey}`;
}

export { newId };
