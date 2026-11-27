export interface ExecutorDescriptor {
  id: string;
  kind: "mcp" | "cli";
  available: boolean;
  reason?: string;
  capabilities: Record<string, boolean>;
}

export interface RunStreamEvent {
  seq: number;
  runId: string;
  taskId: string;
  type: "thinking" | "tool_call" | "tool_result" | "shell" | "patch" | "status" | "error";
  at: number;
  summary: string;
  data?: unknown;
}

export interface RepoDeliveryState {
  name: string;
  sourcePath: string;
  baseRef: string;
  baseSha?: string | null;
  headSha?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  mrId?: string | null;
  mrUrl?: string | null;
  mrHeadSha?: string | null;
  ciStatus?: "pending" | "passed" | "failed" | "stale" | "unknown" | null;
  ciHeadSha?: string | null;
}

export interface OperationSummary {
  operationId: string;
  kind: string;
  status: string;
  operationKey: string | null;
  clientRequestId: string;
  receipt: unknown;
  reconciledAt: string | null;
}

export interface TaskSummary {
  taskId: string;
  status: string;
  waitingReason: string | null;
  inputDigest: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends TaskSummary {
  kind?: "sse_log" | "repo_delivery";
  executorId?: string | null;
  threadId: string | null;
  runId: string | null;
  result: unknown;
  failureReason: string | null;
  briefVersion: number;
  verification: {
    result: string;
    verifierVersion: string;
    findings: unknown[];
    createdAt: string;
    stale?: boolean;
    candidateDigest?: string | null;
  } | null;
  repos?: RepoDeliveryState[];
  operations?: OperationSummary[];
}

export interface InboxItem {
  taskId: string;
  decisionKey: string;
  title: string;
  summary: string;
  action: string | null;
  options: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Proposal {
  proposalId: string;
  taskId: string;
  status: string;
  change: {
    kind: "brief" | "grant";
    diff: Array<{ field: string; before: string; after: string }>;
  };
  expectedBriefVersion: number;
  expectedGrantVersion: number;
  reason: string;
  createdAt: string;
  decidedAt: string | null;
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

export interface EfficiencyMetricsSnapshot {
  totalTasks: number;
  terminalTasks: number;
  verifiedCompletedTasks: number;
  verifiedDeliveryRate: number | null;
  avgDurationMs: number | null;
  totalHandoffs: number;
  totalHumanInterruptions: number;
  totalSilentAutoGrants: number;
  inboxTelemetryLeaks: number;
  costUsd: number | null;
  costStatus: "measured" | "unknown_unmetered";
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

  health(): Promise<{ ok: boolean; latestSeq: number; t3: string; defaultRepoPath?: string; executors?: ExecutorDescriptor[] }> {
    return this.call("/api/health");
  }

  executors(): Promise<{ executors: ExecutorDescriptor[] }> {
    return this.call("/api/executors");
  }

  taskRuns(taskId: string): Promise<{ taskId: string; runs: string[] }> {
    return this.call(`/api/tasks/${encodeURIComponent(taskId)}/runs`);
  }

  runStream(taskId: string, runId: string, afterSeq = 0): Promise<{ taskId: string; runId: string; events: RunStreamEvent[] }> {
    return this.call(`/api/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/stream?afterSeq=${afterSeq}&format=json`);
  }

  steer(taskId: string, message: string): Promise<{ taskId: string; accepted: boolean; runId: string | null; reason?: string }> {
    return this.call(`/api/tasks/${encodeURIComponent(taskId)}/steer`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }

  reconcileOperation(operationId: string): Promise<{ operationId: string; reconciled: boolean; status: string; message: string }> {
    return this.call(`/api/operations/${encodeURIComponent(operationId)}/reconcile`, { method: "POST" });
  }

  resolveOperation(
    operationId: string,
    resolution: "confirmed_exists" | "confirmed_absent",
    extra?: { mrId?: string; url?: string; reason?: string },
  ): Promise<{ operationId: string; status: string; message: string }> {
    return this.call(`/api/operations/${encodeURIComponent(operationId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution, ...(extra ?? {}) }),
    });
  }

  handoff(taskId: string, executorId: string, reason = "Web 界面切换执行器"): Promise<{ taskId: string; fromGeneration: number; toGeneration: number; toExecutor: string }> {
    return this.call(`/api/tasks/${encodeURIComponent(taskId)}/handoff`, {
      method: "POST",
      body: JSON.stringify({ executorId, reason }),
    });
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

  createRepoTask(input: {
    requestId: string;
    requestText: string;
    executorId: string;
    sourcePath: string;
    baseRef: string;
    checkCommand: string;
    maxRepairRounds?: number;
  }): Promise<{ taskId: string; status: string }> {
    const repoName = input.sourcePath.replace(/\/+$/, "").split("/").at(-1) || "repo";
    return this.call("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        requestId: input.requestId,
        kind: "repo_delivery",
        requestText: input.requestText,
        executorId: input.executorId,
        repos: [{ sourcePath: input.sourcePath, baseRef: input.baseRef, name: repoName }],
        maxRepairRounds: input.maxRepairRounds ?? 2,
        verificationPlan: {
          version: "web-check-v1",
          steps: [{ type: "command_check", name: "verify", command: input.checkCommand, repo: repoName }],
        },
      }),
    });
  }

  inbox(): Promise<{ items: InboxItem[] }> {
    return this.call("/api/inbox");
  }

  policy(): Promise<PolicySnapshot> {
    return this.call("/api/policy");
  }

  metrics(): Promise<EfficiencyMetricsSnapshot> {
    return this.call("/api/metrics");
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

  listProposals(taskId: string): Promise<{ proposals: Proposal[] }> {
    return this.call(`/api/tasks/${encodeURIComponent(taskId)}/proposals`);
  }

  proposeGoal(taskId: string, goal: string, reason = "Web 界面起草约定变更"): Promise<Proposal> {
    return this.call(`/api/tasks/${encodeURIComponent(taskId)}/proposals`, {
      method: "POST",
      body: JSON.stringify({ kind: "brief", goal, reason }),
    });
  }

  confirmProposal(proposalId: string): Promise<{ applied: boolean; briefVersion: number }> {
    return this.call(`/api/proposals/${encodeURIComponent(proposalId)}/confirm`, { method: "POST" });
  }

  cancelProposal(proposalId: string): Promise<{ status: string }> {
    return this.call(`/api/proposals/${encodeURIComponent(proposalId)}/cancel`, { method: "POST" });
  }

  async taskEvents(taskId: string, afterSeq: number): Promise<TaskEvent[]> {
    const res = await this.call<{ events: TaskEvent[] }>(
      `/api/tasks/${encodeURIComponent(taskId)}/events?afterSeq=${afterSeq}&format=json`,
    );
    return res.events;
  }
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

/** Subscribes to live NDJSON `RunStreamEvent`s for one run without touching `task_events`. */
export function subscribeRunStream(
  token: string | null,
  taskId: string,
  runId: string,
  afterSeq: number,
  onEvent: (event: RunStreamEvent) => void,
): () => void {
  let closed = false;
  let cursor = afterSeq;
  let socket: EventSource | null = null;
  let retryTimer: number | null = null;

  const connect = () => {
    if (closed) return;
    const query = token ? `&token=${encodeURIComponent(token)}` : "";
    socket = new EventSource(
      `/api/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/stream?afterSeq=${cursor}${query}`,
    );
    socket.addEventListener("run_event", (message) => {
      try {
        const event = JSON.parse((message as MessageEvent<string>).data) as RunStreamEvent;
        if (event.seq <= cursor) return;
        cursor = event.seq;
        onEvent(event);
      } catch {
        // ignore malformed frame
      }
    });
    socket.onerror = () => {
      socket?.close();
      socket = null;
      if (closed) return;
      retryTimer = window.setTimeout(connect, 2000);
    };
  };

  connect();
  return () => {
    closed = true;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    socket?.close();
  };
}
