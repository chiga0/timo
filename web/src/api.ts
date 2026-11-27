export interface ExecutorDescriptor {
  id: string;
  kind: "mcp" | "cli";
  available: boolean;
  reason?: string;
  capabilities: Record<string, boolean>;
}

export interface DiscoveredModel {
  id: string;
  label: string;
}

export interface DiscoveredProvider {
  id: string;
  name: string;
  models: DiscoveredModel[];
}

export interface ExecutorProviderCatalog {
  executorId: string;
  defaultProvider?: string;
  defaultModel?: string;
  providers: DiscoveredProvider[];
}

export interface RunStreamEvent {
  seq: number;
  runId: string;
  taskId: string;
  type: "text_delta" | "thinking" | "tool_call" | "tool_result" | "shell" | "patch" | "status" | "error";
  at: number;
  summary: string;
  data?: unknown;
}

export interface ChatMessage {
  messageId: string;
  role: "user" | "assistant" | "task_card";
  content: string;
  taskId: string | null;
  executorId: string | null;
  model: string | null;
  status: "streaming" | "done" | "error";
  createdAt: string;
  updatedAt: string;
}

export interface TaskProgressFrame {
  taskId: string;
  runId: string;
  type: string;
  summary: string;
  at: number;
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
  title?: string;
  archivedAt?: string | null;
  kind?: "sse_log" | "repo_delivery" | "assistant_chat";
  executorId?: string | null;
  repoNames?: string[];
  status: string;
  waitingReason: string | null;
  inputDigest: string;
  resultSummary?: string | null;
  failureReason?: string | null;
  liveSummary?: string;
  liveType?: string;
  liveAt?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends TaskSummary {
  requestText?: string;
  kind?: "sse_log" | "repo_delivery" | "assistant_chat";
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

export interface PolicyRuleItem {
  action: string;
  environment?: string | null;
  resource?: string | null;
}

export interface PolicySnapshot {
  source: string;
  summary: string;
  warning?: string;
  policy?: {
    version: number;
    tier0: PolicyRuleItem[];
    tier1: PolicyRuleItem[];
    tier2: PolicyRuleItem[];
    budget: { maxRunMinutes: number; maxAttempts: number };
    denyUnknownAsTier2: boolean;
  };
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

export interface AssistantSettings {
  defaultExecutor: string;
  executorModels: Record<string, string>;
  systemPrompt: string;
  defaultMaxRepairRounds: number;
}

export type ConnectionKind = "github" | "enterprise_git" | "gitlab" | "log_service" | "service_registry";

export interface ProjectRepoConfig {
  id: string;
  name: string;
  localPath: string;
  baseRef: string;
  checkCommand: string;
  platformId?: string;
  remoteRepo?: string;
  description?: string;
}

export interface KnowledgeSourceConfig {
  id: string;
  name: string;
  path: string;
  scope: string;
  enabled: boolean;
  description?: string;
}

export interface PlatformConnectionConfig {
  id: string;
  name: string;
  kind: ConnectionKind;
  baseUrl: string;
  apiPath?: string;
  authHeader?: string;
  credentialKey: string;
  notes?: string;
}

export interface WorkspaceFolderConfig {
  id: string;
  name: string;
  path: string;
  kind?: "git" | "docs";
  baseRef?: string;
  checkCommand?: string;
  remoteHost?: string;
  remoteRepo?: string;
  description?: string;
}

export interface InspectedFolder {
  path: string;
  name: string;
  exists: boolean;
  isDirectory: boolean;
  kind: "git" | "docs";
  baseRef?: string;
  remoteHost?: string;
  remoteRepo?: string;
  detectedCheckCommand?: string;
}

export interface TimoUserSettings {
  version: 1;
  assistant: AssistantSettings;
  defaultProjectId: string | null;
  defaultFolderId?: string | null;
  folders?: WorkspaceFolderConfig[];
  workspaceRules?: string;
  autoCleanupWorktrees?: boolean;
  projects: ProjectRepoConfig[];
  knowledge: KnowledgeSourceConfig[];
  connections: PlatformConnectionConfig[];
}

export interface ManagedWorktree {
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  generation: number;
  root: string;
  repos: Array<{
    name: string;
    sourcePath: string;
    branch: string;
    baseRef: string;
    baseSha: string;
    headSha: string | null;
    dirty: boolean;
  }>;
}

export interface CredentialStatus {
  key: string;
  configured: boolean;
  source: "env" | "file" | "unset";
}

export interface LocalPlatformAuthSnapshot {
  gitAvailable: boolean;
  gitCredentialHelper?: string;
  sshKeysCount: number;
  ghLoggedIn: boolean;
  ghSummary?: string;
  detectedRemoteHosts: string[];
}

export interface SettingsPayload {
  settings: TimoUserSettings;
  paths: {
    projects: Record<string, { exists: boolean; isGitRepo: boolean }>;
    knowledge: Record<string, { exists: boolean; kind: "file" | "dir" | "missing" }>;
  };
  folderMeta?: Record<string, InspectedFolder>;
  localAuth?: LocalPlatformAuthSnapshot;
  credentials: CredentialStatus[];
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

  executorProviders(refresh = false): Promise<{ providers: Record<string, ExecutorProviderCatalog> }> {
    return this.call(`/api/executors/providers${refresh ? "?refresh=1" : ""}`);
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

  getChat(limit = 200): Promise<{ messages: ChatMessage[] }> {
    return this.call(`/api/chat?limit=${limit}`);
  }

  sendChat(input: {
    text: string;
    mode?: "auto" | "repo_delivery" | "sse_log";
    executorId?: string;
    model?: string;
    sourcePath?: string;
    baseRef?: string;
    checkCommand?: string;
    maxRepairRounds?: number;
  }): Promise<
    | { kind: "chat"; userMessage: ChatMessage; assistantMessage: ChatMessage }
    | { kind: "task"; userMessage: ChatMessage; taskCardMessage: ChatMessage; taskId: string }
  > {
    return this.call("/api/chat/send", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  stopChat(messageId?: string): Promise<{ stopped: number }> {
    return this.call("/api/chat/stop", {
      method: "POST",
      body: JSON.stringify(messageId ? { messageId } : {}),
    });
  }

  clearChat(): Promise<{ cleared: boolean }> {
    return this.call("/api/chat", { method: "DELETE" });
  }

  listTasks(archived: "exclude" | "only" | "all" = "exclude"): Promise<{ tasks: TaskSummary[] }> {
    const query = archived === "exclude" ? "" : `?archived=${encodeURIComponent(archived)}`;
    return this.call(`/api/tasks${query}`);
  }

  getTask(taskId: string): Promise<TaskDetail> {
    return this.call(`/api/tasks/${encodeURIComponent(taskId)}`);
  }

  updateTask(taskId: string, patch: { title?: string | null; archived?: boolean }): Promise<TaskDetail> {
    return this.call(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  deleteTask(taskId: string, force = false): Promise<{ deleted: true; taskId: string; removedWorktrees: number }> {
    const query = force ? "?force=1" : "";
    return this.call(`/api/tasks/${encodeURIComponent(taskId)}${query}`, {
      method: "DELETE",
    });
  }

  createTask(requestId: string, logBase64: string): Promise<{ taskId: string; status: string }> {
    return this.call("/api/tasks", { method: "POST", body: JSON.stringify({ requestId, log: logBase64 }) });
  }

  createRepoTask(input: {
    requestId: string;
    requestText: string;
    executorId: string;
    model?: string;
    /** Omit or leave empty to let Timo automatically match folders from the managed workspace. */
    sourcePath?: string;
    baseRef?: string;
    checkCommand?: string;
    maxRepairRounds?: number;
  }): Promise<{ taskId: string; status: string }> {
    const sourcePath = input.sourcePath?.trim() ?? "";
    const checkCmd = input.checkCommand?.trim() ?? "";
    if (!sourcePath) {
      return this.call("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          requestId: input.requestId,
          kind: "repo_delivery",
          requestText: input.requestText,
          executorId: input.executorId,
          ...(input.model?.trim() ? { model: input.model.trim() } : {}),
          repos: [],
          maxRepairRounds: input.maxRepairRounds ?? 2,
          ...(checkCmd
            ? { verificationPlan: { version: "web-check-v1", steps: [{ type: "command_check", name: "verify", command: checkCmd }] } }
            : {}),
        }),
      });
    }
    const repoName = sourcePath.replace(/\/+$/, "").split("/").at(-1) || "repo";
    return this.call("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        requestId: input.requestId,
        kind: "repo_delivery",
        requestText: input.requestText,
        executorId: input.executorId,
        ...(input.model?.trim() ? { model: input.model.trim() } : {}),
        repos: [{ sourcePath, baseRef: input.baseRef?.trim() || "main", name: repoName }],
        maxRepairRounds: input.maxRepairRounds ?? 2,
        verificationPlan: {
          version: "web-check-v1",
          steps: checkCmd ? [{ type: "command_check", name: "verify", command: checkCmd, repo: repoName }] : [],
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

  getSettings(): Promise<SettingsPayload> {
    return this.call("/api/settings");
  }

  saveSettings(settings: TimoUserSettings): Promise<SettingsPayload> {
    return this.call("/api/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  }

  setCredential(key: string, value: string): Promise<{ credential: CredentialStatus; credentials: CredentialStatus[] }> {
    return this.call("/api/credentials", {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    });
  }

  testConnection(connectionId: string): Promise<{ connectionId: string; ok: boolean; status?: number; message: string }> {
    return this.call(`/api/connections/${encodeURIComponent(connectionId)}/test`, { method: "POST" });
  }

  pickFolder(): Promise<{ cancelled: boolean; folder?: InspectedFolder; error?: string }> {
    return this.call("/api/fs/pick-folder", { method: "POST" });
  }

  inspectFolder(path: string): Promise<{ folder: InspectedFolder }> {
    return this.call("/api/fs/inspect-folder", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
  }

  scanWorkspaceRoot(path?: string): Promise<{ cancelled: boolean; rootPath?: string; folders: InspectedFolder[]; error?: string }> {
    return this.call("/api/workspace/scan-root", {
      method: "POST",
      body: JSON.stringify(path ? { path } : {}),
    });
  }

  listWorkspaces(): Promise<{ worktrees: ManagedWorktree[] }> {
    return this.call("/api/workspaces");
  }

  cleanupWorkspaces(input?: { taskId?: string; generation?: number; force?: boolean }): Promise<{ removed: number; skipped: number }> {
    return this.call("/api/workspaces/cleanup", {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    });
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

  retry(taskId: string): Promise<{ taskId: string; status: string; generation: number }> {
    return this.call(`/api/tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST", body: JSON.stringify({}) });
  }

  dismissInbox(taskId: string, decisionKey: string): Promise<{ dismissed: boolean }> {
    return this.call(`/api/inbox/${encodeURIComponent(taskId)}/${encodeURIComponent(decisionKey)}/dismiss`, {
      method: "POST",
      body: JSON.stringify({}),
    });
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

/** Subscribes to live Main Chat SSE deltas and compact task card progress updates. */
export function subscribeChatStream(
  token: string | null,
  handlers: {
    onMessage?: (msg: ChatMessage) => void;
    onDelta?: (delta: { messageId: string; delta: string; content: string }) => void;
    onDone?: (msg: ChatMessage) => void;
    onTaskProgress?: (frame: TaskProgressFrame) => void;
  },
): () => void {
  let closed = false;
  let socket: EventSource | null = null;
  let retryTimer: number | null = null;

  const connect = () => {
    if (closed) return;
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    socket = new EventSource(`/api/chat/stream${query}`);
    socket.addEventListener("chat_message", (ev) => {
      try {
        handlers.onMessage?.(JSON.parse((ev as MessageEvent<string>).data) as ChatMessage);
      } catch {
        // ignore malformed frame
      }
    });
    socket.addEventListener("chat_delta", (ev) => {
      try {
        handlers.onDelta?.(JSON.parse((ev as MessageEvent<string>).data) as { messageId: string; delta: string; content: string });
      } catch {
        // ignore
      }
    });
    socket.addEventListener("chat_done", (ev) => {
      try {
        handlers.onDone?.(JSON.parse((ev as MessageEvent<string>).data) as ChatMessage);
      } catch {
        // ignore
      }
    });
    socket.addEventListener("task_progress", (ev) => {
      try {
        handlers.onTaskProgress?.(JSON.parse((ev as MessageEvent<string>).data) as TaskProgressFrame);
      } catch {
        // ignore
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
