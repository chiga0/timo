export interface TaskSummary {
  taskId: string;
  status: string;
  waitingReason: string | null;
  inputDigest: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends TaskSummary {
  threadId: string | null;
  runId: string | null;
  result: unknown;
  failureReason: string | null;
  briefVersion: number;
  verification: { result: string; verifierVersion: string; findings: unknown[]; createdAt: string } | null;
}

export interface InboxItem {
  taskId: string;
  decisionKey: string;
  title: string;
  summary: string;
  options: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  seq: number;
  eventId: string;
  taskId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface PolicySnapshot {
  source: string;
  summary: string;
  warning?: string;
}

/**
 * Session token plumbing. The token is read from the page URL (`?token=`) or a
 * cookie set by the server; it is kept in memory and never written to storage.
 */
export function readSessionToken(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get("token");
  if (fromUrl) return fromUrl;
  for (const part of document.cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "timo_session") return rest.join("=");
  }
  return null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class Api {
  constructor(private readonly token: string | null) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (init.body) headers["content-type"] = "application/json";
    const response = await fetch(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
    const text = await response.text();
    const parsed: unknown = text === "" ? undefined : JSON.parse(text);
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ApiError(response.status, error?.code ?? "error", error?.message ?? `HTTP ${response.status}`);
    }
    return parsed as T;
  }

  health(): Promise<{ ok: boolean; latestSeq: number; t3: string }> {
    return this.call("/api/health");
  }

  listTasks(): Promise<{ tasks: TaskSummary[] }> {
    return this.call("/api/tasks");
  }

  getTask(taskId: string): Promise<TaskDetail> {
    return this.call(`/api/tasks/${encodeURIComponent(taskId)}`);
  }

  createTask(requestId: string, logBase64: string): Promise<{ taskId: string; status: string }> {
    return this.call("/api/tasks", { method: "POST", body: JSON.stringify({ requestId, log: logBase64 }) });
  }

  inbox(): Promise<{ items: InboxItem[] }> {
    return this.call("/api/inbox");
  }

  policy(): Promise<PolicySnapshot> {
    return this.call("/api/policy");
  }

  amend(taskId: string, expectedBriefVersion: number, goal: string): Promise<{ briefVersion: number }> {
    return this.call(`/api/tasks/${encodeURIComponent(taskId)}/amend`, {
      method: "POST",
      body: JSON.stringify({ expectedBriefVersion, goal }),
    });
  }

  stop(taskId: string): Promise<{ status: string }> {
    return this.call(`/api/tasks/${encodeURIComponent(taskId)}/stop`, { method: "POST", body: JSON.stringify({ reason: "user_requested" }) });
  }

  resolve(taskId: string, action: string, approved: boolean): Promise<{ status: string }> {
    return this.call(`/api/tasks/${encodeURIComponent(taskId)}/authorize/resolve`, {
      method: "POST",
      body: JSON.stringify({ action, approved }),
    });
  }

  taskEvents(taskId: string, afterSeq: number): Promise<TaskEvent[]> {
    return streamOnce(`/api/tasks/${encodeURIComponent(taskId)}/events?afterSeq=${afterSeq}`, this.token);
  }
}

/** Reads one finite slice of an SSE stream (the server closes after replay). */
async function streamOnce(path: string, token: string | null): Promise<TaskEvent[]> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  const events: TaskEvent[] = [];
  try {
    const response = await fetch(path, { headers, signal: controller.signal });
    const reader = response.body?.getReader();
    if (!reader) return events;
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("");
        if (data) events.push(JSON.parse(data) as TaskEvent);
      }
    }
  } catch {
    // The abort is how a finite slice ends when the stream stays open.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

/**
 * Live subscription to the global event stream, resuming from `afterSeq`. The
 * server replays history first, so a dropped connection loses nothing.
 */
export function subscribeEvents(
  token: string | null,
  afterSeq: number,
  onEvent: (event: TaskEvent) => void,
  onState: (state: "open" | "reconnecting" | "closed") => void,
): () => void {
  let closed = false;
  let cursor = afterSeq;
  let socket: EventSource | null = null;
  let retryTimer: number | null = null;

  const connect = () => {
    if (closed) return;
    // EventSource cannot send headers, so the token rides in the cookie or query.
    const query = token ? `&token=${encodeURIComponent(token)}` : "";
    socket = new EventSource(`/api/events?afterSeq=${cursor}${query}`);
    socket.onopen = () => onState("open");
    socket.addEventListener("task_event", (message) => {
      try {
        const event = JSON.parse((message as MessageEvent<string>).data) as TaskEvent;
        if (event.seq <= cursor) return;
        cursor = event.seq;
        onEvent(event);
      } catch {
        // A malformed frame must not break the stream.
      }
    });
    socket.onerror = () => {
      socket?.close();
      socket = null;
      if (closed) return;
      onState("reconnecting");
      retryTimer = window.setTimeout(connect, 2000);
    };
  };

  connect();
  return () => {
    closed = true;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    socket?.close();
    onState("closed");
  };
}
