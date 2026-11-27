import type { Database } from "./database.js";
import type { ChatAttachment } from "./attachments.js";
import { newId, toIso } from "../util.js";

export type ChatRole = "user" | "assistant" | "task_card";
export type ChatMessageStatus = "streaming" | "done" | "error";

export interface ChatMessage {
  messageId: string;
  role: ChatRole;
  content: string;
  taskId: string | null;
  executorId: string | null;
  model: string | null;
  status: ChatMessageStatus;
  attachments?: ChatAttachment[];
  createdAt: string;
  updatedAt: string;
}

interface ChatRow {
  message_id: string;
  role: ChatRole;
  content: string;
  task_id: string | null;
  executor_id: string | null;
  model: string | null;
  status: ChatMessageStatus;
  attachments_json?: string | null;
  created_at: string;
  updated_at: string;
}

function parseAttachments(raw?: string | null): ChatAttachment[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as ChatAttachment[]) : undefined;
  } catch {
    return undefined;
  }
}

function toMessage(row: ChatRow): ChatMessage {
  const attachments = parseAttachments(row.attachments_json);
  return {
    messageId: row.message_id,
    role: row.role,
    content: row.content,
    taskId: row.task_id ?? null,
    executorId: row.executor_id ?? null,
    model: row.model ?? null,
    status: row.status,
    ...(attachments ? { attachments } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Persistent timeline for the fixed global Main Chat (`User <-> Timo`).
 * Conversational Q&A lives here directly without polluting `tasks`; delegated
 * async jobs appear here as live-updating `task_card` entries linked to `taskId`.
 */
export class ChatStore {
  constructor(private readonly db: Database) {}

  list(limit = 200): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT *, rowid AS rid FROM chat_messages ORDER BY created_at DESC, rowid DESC LIMIT ?
         ) ORDER BY created_at ASC, rid ASC`,
      )
      .all(limit) as ChatRow[];
    return rows.map(toMessage);
  }

  get(messageId: string): ChatMessage | undefined {
    const row = this.db.prepare("SELECT * FROM chat_messages WHERE message_id = ?").get(messageId) as ChatRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  append(input: {
    messageId?: string;
    role: ChatRole;
    content?: string;
    taskId?: string | null;
    executorId?: string | null;
    model?: string | null;
    status?: ChatMessageStatus;
    attachments?: ChatAttachment[];
    now?: string;
  }): ChatMessage {
    const id = input.messageId ?? newId();
    const now = input.now ?? toIso(new Date());
    const attachmentsJson =
      input.attachments && input.attachments.length > 0 ? JSON.stringify(input.attachments) : null;
    this.db
      .prepare(
        `INSERT INTO chat_messages (message_id, role, content, task_id, executor_id, model, status, attachments_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.role,
        input.content ?? "",
        input.taskId ?? null,
        input.executorId ?? null,
        input.model ?? null,
        input.status ?? "done",
        attachmentsJson,
        now,
        now,
      );
    return this.get(id)!;
  }

  update(messageId: string, patch: { content?: string; status?: ChatMessageStatus; now?: string }): ChatMessage | undefined {
    const now = patch.now ?? toIso(new Date());
    const sets: string[] = [];
    const params: Array<string | null> = [];
    if (patch.content !== undefined) {
      sets.push("content = ?");
      params.push(patch.content);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      params.push(now);
      params.push(messageId);
      this.db.prepare(`UPDATE chat_messages SET ${sets.join(", ")} WHERE message_id = ?`).run(...params);
    }
    return this.get(messageId);
  }

  removeByTaskId(taskId: string): void {
    this.db.prepare("DELETE FROM chat_messages WHERE task_id = ?").run(taskId);
  }

  /** Marks any leftover `streaming` messages from a previous process crash/restart as `done`. */
  settleOrphanedStreaming(now = toIso(new Date())): number {
    const res = this.db
      .prepare(
        `UPDATE chat_messages
         SET status = 'done', updated_at = ?
         WHERE status = 'streaming'`,
      )
      .run(now) as { changes?: number };
    return Number(res.changes ?? 0);
  }

  clear(): void {
    this.db.prepare("DELETE FROM chat_messages").run();
  }
}

export type ChatStreamFrame =
  | { event: "chat_message"; data: ChatMessage }
  | { event: "chat_delta"; data: { messageId: string; delta: string; content: string } }
  | { event: "chat_step"; data: { messageId: string; type: string; summary: string; at: number } }
  | { event: "chat_done"; data: ChatMessage }
  | { event: "task_progress"; data: { taskId: string; runId: string; type: string; summary: string; at: number } };

/** In-process fan-out bus powering real-time SSE streaming to the Main Chat UI. */
export class ChatStreamBus {
  private readonly listeners = new Set<(frame: ChatStreamFrame) => void>();

  publish(frame: ChatStreamFrame): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch {
        // Ignore broken subscriber.
      }
    }
  }

  subscribe(listener: (frame: ChatStreamFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
