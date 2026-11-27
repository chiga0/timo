import type { Router } from "../http/server.js";
import { RouteError } from "../http/server.js";
import type { TaskService } from "../service/task-service.js";
import { TaskConflictError, TaskNotFoundError, InvalidInputError } from "../service/task-service.js";
import { ProposalConflictError } from "../auth/proposals.js";
import { RequestConflictError } from "../store/tasks.js";
import { CommandError } from "../ipc.js";
import type { EventLedger } from "../events/ledger.js";
import type { TypedEventBus } from "../events/bus.js";
import type { TaskEvent } from "../events/types.js";
import type { ExecutorRegistry, RunStreamEvent } from "../adapters/execution.js";
import type { RunStreamStore } from "../workspace/run-stream.js";
import type { RepoRequest, WorkspaceManager } from "../workspace/manager.js";
import type { VerificationPlan } from "../verify/pipeline.js";
import type { SettingsStore } from "../settings.js";
import { EnterpriseGitPlatformAdapter } from "../platform/adapter.js";
import { discoverExecutorProviders, type ExecutorProviderCatalog } from "../adapters/providers.js";
import { inspectLocalFolder, pickNativeFolder, probeLocalPlatformAuth, scanWorkspaceRoot, selectFoldersForRequest } from "../workspace/inspect.js";
import type { ChatStore, ChatStreamBus, ChatStreamFrame } from "../store/chat.js";
import type { MainChatRunner } from "../service/chat-runner.js";
import type { SkillRegistry } from "../skills/registry.js";

export interface ApiDeps {
  service: TaskService;
  ledger: EventLedger;
  bus: TypedEventBus;
  /** Heartbeat interval for SSE streams, in ms. */
  heartbeatMs?: number;
  /** Human-readable service start time, for `/api/health`. */
  startedAt: string;
  t3Configured: boolean;
  /** Probed executor registry (Step 3.2). */
  executors?: ExecutorRegistry;
  /** Live run stream store (Step 3.2). */
  runStreams?: RunStreamStore;
  /** Workspace, assistant, knowledge & isolated credential settings store. */
  settingsStore?: SettingsStore;
  /** Executor-agnostic Timo Unified Skills registry (`~/.timo/skills`). */
  skillRegistry?: SkillRegistry;
  /** Autonomous multi-repo worktree manager for inspection & managed cleanup. */
  workspaces?: WorkspaceManager;
  /** Gateway token revocation hook when force-deleting an active task. */
  mcpGateway?: { revoke(taskId: string, generation?: number): void; listChiefToolNames?(): string[] };
  /** Interrupts an in-flight run (used on force-delete). */
  interruptActive?: (taskId: string) => Promise<void>;
  /** Live steering hook into the runner (Step 3.2). */
  steer?: (taskId: string, message: string) => Promise<{ accepted: boolean; runId: string | null; reason?: string }>;
  /** Fixed Main Chat store, SSE bus, and runner. */
  chatStore?: ChatStore;
  chatBus?: ChatStreamBus;
  chatRunner?: MainChatRunner;
  /** Operation reconciliation hook (Step 4.2). */
  reconcileOperation?: (operationId: string) => Promise<unknown>;
  /** Operator resolution for effect_unknown (Step 5.2). */
  resolveOperation?: (
    operationId: string,
    input: { resolution: "confirmed_exists" | "confirmed_absent"; mrId?: string; url?: string; headSha?: string; reason?: string },
  ) => unknown;
  /** Immutable g1 -> g2 executor handoff hook (Step 5.1). */
  handoff?: (taskId: string, input: { executorId: string; model?: string; reason?: string }) => Promise<unknown>;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

/**
 * REST + SSE surface shared by the CLI (over the Unix socket) and the Web
 * console (over loopback with a session token). Both hit the same application
 * layer, so the CLI cannot drift from what the browser sees.
 */
export function registerApi(router: Router, deps: ApiDeps): void {
  const heartbeatMs = deps.heartbeatMs ?? 15_000;

  router.add("GET", "/api/health", () => ({
    body: {
      ok: true,
      startedAt: deps.startedAt,
      latestSeq: deps.ledger.latestSeq(),
      t3: deps.t3Configured ? "configured" : "unconfigured",
      defaultRepoPath: process.cwd(),
      executors: deps.executors?.snapshot() ?? [],
    },
  }));

  router.add("GET", "/api/executors", () => ({
    body: { executors: deps.executors?.snapshot() ?? [] },
  }));

  let cachedProviders: { at: number; data: Record<string, ExecutorProviderCatalog> } | null = null;
  router.add("GET", "/api/executors/providers", (context) => {
    const force = context.query.get("refresh") === "1";
    const now = Date.now();
    if (force || !cachedProviders || now - cachedProviders.at > 60_000) {
      cachedProviders = { at: now, data: discoverExecutorProviders() };
    }
    return { body: { providers: cachedProviders.data } };
  });

  // ---- Workspace Settings, Knowledge Base & Isolated Credentials ----

  router.add("GET", "/api/settings", () => {
    if (!deps.settingsStore) {
      throw new RouteError(501, "unsupported", "settings store is not configured");
    }
    const settings = deps.settingsStore.load();
    const inspectedFolders = Object.fromEntries(
      (settings.folders ?? []).map((f) => [f.id, inspectLocalFolder(f.path)]),
    );
    return {
      body: {
        settings,
        paths: deps.settingsStore.inspectPaths(settings),
        folderMeta: inspectedFolders,
        localAuth: probeLocalPlatformAuth(Object.values(inspectedFolders)),
        credentials: deps.settingsStore.listCredentialStatuses(),
      },
    };
  });

  router.add("PUT", "/api/settings", (context) => {
    if (!deps.settingsStore) {
      throw new RouteError(501, "unsupported", "settings store is not configured");
    }
    const saved = deps.settingsStore.save(context.body);
    const inspectedFolders = Object.fromEntries(
      (saved.folders ?? []).map((f) => [f.id, inspectLocalFolder(f.path)]),
    );
    return {
      body: {
        settings: saved,
        paths: deps.settingsStore.inspectPaths(saved),
        folderMeta: inspectedFolders,
        localAuth: probeLocalPlatformAuth(Object.values(inspectedFolders)),
        credentials: deps.settingsStore.listCredentialStatuses(),
      },
    };
  });

  router.add("POST", "/api/fs/pick-folder", async () => {
    const picked = await pickNativeFolder();
    if (picked.cancelled || !picked.path) {
      return { body: { cancelled: true, ...(picked.error ? { error: picked.error } : {}) } };
    }
    return { body: { cancelled: false, folder: inspectLocalFolder(picked.path) } };
  });

  router.add("POST", "/api/fs/inspect-folder", (context) => {
    const body = asRecord(context.body);
    const path = requireString(body.path, "path");
    return { body: { folder: inspectLocalFolder(path) } };
  });

  router.add("POST", "/api/workspace/scan-root", async (context) => {
    const body = asRecord(context.body);
    let rootPath = optionalString(body.path);
    if (!rootPath) {
      const picked = await pickNativeFolder();
      if (picked.cancelled || !picked.path) {
        return { body: { cancelled: true, folders: [], ...(picked.error ? { error: picked.error } : {}) } };
      }
      rootPath = picked.path;
    }
    const discovered = scanWorkspaceRoot(rootPath, 2, 40);
    return { body: { cancelled: false, rootPath, folders: discovered } };
  });

  router.add("GET", "/api/workspaces", () => {
    if (!deps.workspaces) {
      return { body: { worktrees: [] } };
    }
    const items = deps.workspaces.listWorkspaces().map((ws) => {
      let taskStatus = "unknown";
      let taskTitle = ws.taskId.slice(0, 8);
      try {
        const task = deps.service.getTask(ws.taskId);
        taskStatus = task.status;
        taskTitle = task.title ?? taskTitle;
      } catch {
        // orphaned worktree from a cleared DB
      }
      return { ...ws, taskStatus, taskTitle };
    });
    return { body: { worktrees: items } };
  });

  router.add("POST", "/api/workspaces/cleanup", (context) => {
    if (!deps.workspaces) {
      return { body: { removed: 0, skipped: 0, details: [] } };
    }
    const body = asRecord(context.body);
    const force = body.force === true;
    const targetTaskId = optionalString(body.taskId);
    const targetGen = typeof body.generation === "number" ? body.generation : undefined;

    if (targetTaskId) {
      const gen = targetGen ?? 1;
      try {
        const res = deps.workspaces.teardown(targetTaskId, gen, { force });
        return { body: { removed: res.removed ? 1 : 0, skipped: res.removed ? 0 : 1, details: [{ taskId: targetTaskId, generation: gen, ...res }] } };
      } catch (error) {
        throw new RouteError(409, "dirty_workspace", error instanceof Error ? error.message : String(error));
      }
    }

    // Reclaim all worktrees belonging to terminal (or unknown/orphaned) tasks.
    const terminalStatuses = new Set(["completed", "failed", "stopped", "unknown"]);
    const all = deps.workspaces.listWorkspaces();
    let removed = 0;
    let skipped = 0;
    const details: Array<{ taskId: string; generation: number; removed: boolean; reason?: string }> = [];
    for (const ws of all) {
      let status = "unknown";
      try {
        status = deps.service.getTask(ws.taskId).status;
      } catch {
        // orphaned
      }
      if (!terminalStatuses.has(status)) {
        skipped += 1;
        details.push({ taskId: ws.taskId, generation: ws.generation, removed: false, reason: `task_${status}` });
        continue;
      }
      try {
        const res = deps.workspaces.teardown(ws.taskId, ws.generation, { force });
        if (res.removed) removed += 1;
        else skipped += 1;
        details.push({ taskId: ws.taskId, generation: ws.generation, ...res });
      } catch (error) {
        skipped += 1;
        details.push({ taskId: ws.taskId, generation: ws.generation, removed: false, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { body: { removed, skipped, details } };
  });

  router.add("GET", "/api/credentials", () => {
    if (!deps.settingsStore) {
      throw new RouteError(501, "unsupported", "settings store is not configured");
    }
    return { body: { credentials: deps.settingsStore.listCredentialStatuses() } };
  });

  router.add("PUT", "/api/credentials", (context) => {
    if (!deps.settingsStore) {
      throw new RouteError(501, "unsupported", "settings store is not configured");
    }
    const body = asRecord(context.body);
    const key = requireString(body.key, "key");
    const value = typeof body.value === "string" ? body.value : "";
    try {
      const status = deps.settingsStore.setCredential(key, value);
      return { body: { credential: status, credentials: deps.settingsStore.listCredentialStatuses() } };
    } catch (error) {
      throw new RouteError(400, "invalid_input", error instanceof Error ? error.message : String(error));
    }
  });

  router.add("POST", "/api/connections/:id/test", async (context) => {
    if (!deps.settingsStore) {
      throw new RouteError(501, "unsupported", "settings store is not configured");
    }
    const settings = deps.settingsStore.load();
    const conn = settings.connections.find((c) => c.id === context.params.id);
    if (!conn) {
      throw new RouteError(404, "not_found", `connection ${context.params.id} not found`);
    }
    const credentials = deps.settingsStore.resolveGatewayCredentials();
    if (conn.kind === "enterprise_git" || conn.kind === "gitlab") {
      const adapter = new EnterpriseGitPlatformAdapter({
        baseUrl: conn.baseUrl,
        apiPath: conn.apiPath,
        authHeader: conn.authHeader,
        credentialKey: conn.credentialKey,
      });
      const result = await adapter.testConnection(credentials);
      return { body: { connectionId: conn.id, ...result } };
    }
    // Generic HTTP reachability check for GitHub / log / service endpoints.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    timer.unref?.();
    try {
      const res = await fetch(conn.baseUrl, { method: "HEAD", signal: controller.signal });
      return {
        body: {
          connectionId: conn.id,
          ok: res.status < 500,
          status: res.status,
          message: `端点可达（HTTP ${res.status}）`,
        },
      };
    } catch (error) {
      return {
        body: {
          connectionId: conn.id,
          ok: false,
          message: `连接失败：${error instanceof Error ? error.message : String(error)}`,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  });

  router.add("GET", "/api/metrics", (context) => {
    const limit = parsePositiveInt(context.query.get("limit"), 200);
    return { body: deps.service.efficiencyMetrics(limit) };
  });

  router.add("GET", "/api/tasks/:id/metrics", (context) => {
    const taskId = context.params.id!;
    return { body: withMappedErrors(() => deps.service.taskEfficiencyMetrics(taskId)) };
  });

  router.add("GET", "/api/tasks", (context) => {
    const limit = parsePositiveInt(context.query.get("limit"), 200);
    const status = context.query.get("status") ?? undefined;
    const rawArchived = context.query.get("archived");
    const archived = rawArchived === "all" || rawArchived === "only" || rawArchived === "exclude" ? rawArchived : "exclude";
    const tasks = deps.service.listTasks(limit, status, { archived }).map((t) => {
      const live = deps.runStreams?.latestProgress(t.taskId);
      return live ? { ...t, liveSummary: live.summary, liveType: live.type, liveAt: live.at } : t;
    });
    return { body: { tasks } };
  });

  // ---- Fixed Main Chat (User <-> Timo) + Live SSE Stream ----

  router.add("GET", "/api/chat", (context) => {
    const limit = parsePositiveInt(context.query.get("limit"), 200);
    const messages = deps.chatStore ? deps.chatStore.list(limit) : [];
    const settings = deps.settingsStore?.load();
    const skills = deps.skillRegistry ? deps.skillRegistry.list(settings) : [];
    const docFolders = (settings?.folders ?? []).filter((f) => f.kind === "docs").length;
    const explicitKnowledge = (settings?.knowledge ?? []).filter((k) => k.enabled).length;
    const contextSummary = {
      folderCount: (settings?.folders ?? []).length,
      knowledgeCount: explicitKnowledge + docFolders,
      enabledSkillCount: skills.filter((s) => s.enabled).length,
      totalSkillCount: skills.length,
      connectionCount: (settings?.connections ?? []).length,
      chiefMcpTools: deps.mcpGateway?.listChiefToolNames?.() ?? [],
    };
    return { body: { messages, contextSummary } };
  });

  // ---- Timo Unified Skills Management ----

  router.add("GET", "/api/skills", () => {
    if (!deps.skillRegistry) {
      return { body: { managedDir: null, skills: [], externalSources: [] } };
    }
    const settings = deps.settingsStore?.load();
    return {
      body: {
        managedDir: deps.skillRegistry.managedDir,
        skills: deps.skillRegistry.list(settings),
        externalSources: deps.skillRegistry.discoverExternalSources(),
      },
    };
  });

  router.add("POST", "/api/skills", (context) => {
    if (!deps.skillRegistry) {
      throw new RouteError(501, "unsupported", "skill registry is not configured");
    }
    const body = asRecord(context.body);
    const name = requireString(body.name, "name");
    const description = requireString(body.description, "description");
    const content = requireString(body.content, "content");
    const saved = withMappedErrors(() =>
      deps.skillRegistry!.saveManaged({
        id: optionalString(body.id),
        name,
        description,
        content,
        scope: optionalString(body.scope),
      }),
    );
    return { status: 201, body: { skill: saved } };
  });

  router.add("PATCH", "/api/skills/:id", (context) => {
    if (!deps.settingsStore) {
      throw new RouteError(501, "unsupported", "settings store is not configured");
    }
    const id = context.params.id!;
    const body = asRecord(context.body);
    const current = deps.settingsStore.load();
    const existing = current.skillConfigs?.[id] ?? {};
    const nextOverride = {
      ...existing,
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(typeof body.scope === "string" && body.scope.trim() !== "" ? { scope: body.scope.trim() } : {}),
    };
    const saved = deps.settingsStore.save({
      ...current,
      skillConfigs: {
        ...(current.skillConfigs ?? {}),
        [id]: nextOverride,
      },
    });
    const skills = deps.skillRegistry ? deps.skillRegistry.list(saved) : [];
    return { body: { skill: skills.find((s) => s.id === id) ?? null, skills } };
  });

  router.add("DELETE", "/api/skills/:id", (context) => {
    if (!deps.skillRegistry) {
      throw new RouteError(501, "unsupported", "skill registry is not configured");
    }
    const id = context.params.id!;
    const deleted = withMappedErrors(() => deps.skillRegistry!.deleteManaged(id));
    if (!deleted) {
      throw new RouteError(404, "not_found", `managed skill ${id} not found`);
    }
    return { body: { deleted: true, id } };
  });

  router.add("POST", "/api/skills/import", (context) => {
    if (!deps.skillRegistry) {
      throw new RouteError(501, "unsupported", "skill registry is not configured");
    }
    const body = asRecord(context.body);
    const sourceDir = requireString(body.sourceDir, "sourceDir");
    const skillIds = optionalStringArray(body.skillIds);
    const overwrite = body.overwrite === true;
    const outcome = withMappedErrors(() => deps.skillRegistry!.importFromDir(sourceDir, { skillIds, overwrite }));
    const settings = deps.settingsStore?.load();
    return {
      status: 201,
      body: {
        ...outcome,
        skills: deps.skillRegistry.list(settings),
      },
    };
  });

  router.add("POST", "/api/chat/send", (context) => {
    if (!deps.chatRunner) {
      throw new RouteError(501, "unsupported", "main chat runner is not configured");
    }
    const body = asRecord(context.body);
    const text = requireString(body.text, "text");
    const mode = body.mode === "sse_log" || body.mode === "repo_delivery" || body.mode === "auto" ? body.mode : "auto";
    const result = withMappedErrors(() =>
      deps.chatRunner!.send({
        text,
        mode,
        executorId: optionalString(body.executorId),
        model: optionalString(body.model),
        sourcePath: optionalString(body.sourcePath),
        baseRef: optionalString(body.baseRef),
        checkCommand: optionalString(body.checkCommand),
        maxRepairRounds: typeof body.maxRepairRounds === "number" ? body.maxRepairRounds : undefined,
      }),
    );
    return { status: 201, body: result };
  });

  router.add("POST", "/api/chat/stop", async (context) => {
    if (!deps.chatRunner) return { body: { stopped: 0 } };
    const body = asRecord(context.body);
    const result = await deps.chatRunner.stop(optionalString(body.messageId));
    return { body: result };
  });

  router.add("DELETE", "/api/chat", async () => {
    if (deps.chatRunner) await deps.chatRunner.stop();
    deps.chatStore?.clear();
    return { body: { cleared: true } };
  });

  router.add("GET", "/api/chat/stream", () => {
    return {
      stream: async (res, signal) => {
        await streamChatFrames(deps.chatBus, res, signal, heartbeatMs);
      },
    };
  });

  router.add("POST", "/api/tasks", (context) => {
    const body = asRecord(context.body);
    const requestId = requireString(body.requestId, "requestId");
    const kind =
      body.kind === "assistant_chat"
        ? "assistant_chat"
        : body.kind === "repo_delivery" || Array.isArray(body.repos)
          ? "repo_delivery"
          : "sse_log";
    if (kind === "assistant_chat") {
      const userSettings = deps.settingsStore?.load();
      const created = withMappedErrors(() =>
        deps.service.createTask({
          requestId,
          kind: "assistant_chat",
          requestText: typeof body.requestText === "string" ? body.requestText : undefined,
          executorId: typeof body.executorId === "string" ? body.executorId : userSettings?.assistant.defaultExecutor,
          model: typeof body.model === "string" ? body.model : undefined,
        }),
      );
      return { status: 201, body: { taskId: created.taskId, status: created.status, reused: created.reused } };
    }
    if (kind === "repo_delivery") {
      const userSettings = deps.settingsStore?.load();
      const requestText = typeof body.requestText === "string" ? body.requestText : "";
      let repos: RepoRequest[] = Array.isArray(body.repos) ? (body.repos as RepoRequest[]) : [];
      let verificationPlan = body.verificationPlan as VerificationPlan | undefined;
      if (repos.length === 0) {
        const matched = selectFoldersForRequest(requestText, userSettings?.folders ?? []);
        if (matched.length > 0) {
          repos = matched.map((f) => {
            const inspected = inspectLocalFolder(f.path);
            return {
              sourcePath: f.path,
              baseRef: f.baseRef || inspected.baseRef || "main",
              name: f.name,
            };
          });
          if (!verificationPlan) {
            const steps = matched
              .map((f) => ({ repo: f.name, cmd: f.checkCommand || inspectLocalFolder(f.path).detectedCheckCommand }))
              .filter((s): s is { repo: string; cmd: string } => Boolean(s.cmd))
              .map((s) => ({ type: "command_check" as const, name: `verify-${s.repo}`, command: s.cmd, repo: s.repo }));
            verificationPlan = { version: "auto-workspace-v1", steps };
          }
        } else {
          // No specific repo was referenced or pinned: handle cleanly as an
          // assistant conversation without creating unnecessary worktrees or running tests!
          const created = withMappedErrors(() =>
            deps.service.createTask({
              requestId,
              kind: "assistant_chat",
              requestText: requestText || undefined,
              executorId: typeof body.executorId === "string" ? body.executorId : userSettings?.assistant.defaultExecutor,
              model: typeof body.model === "string" ? body.model : undefined,
            }),
          );
          return { status: 201, body: { taskId: created.taskId, status: created.status, reused: created.reused } };
        }
      }
      const created = withMappedErrors(() =>
        deps.service.createTask({
          requestId,
          kind: "repo_delivery",
          requestText: requestText || undefined,
          executorId: typeof body.executorId === "string" ? body.executorId : userSettings?.assistant.defaultExecutor,
          model: typeof body.model === "string" ? body.model : undefined,
          repos,
          verificationPlan,
          maxRepairRounds:
            typeof body.maxRepairRounds === "number" ? body.maxRepairRounds : userSettings?.assistant.defaultMaxRepairRounds,
        }),
      );
      return { status: 201, body: { taskId: created.taskId, status: created.status, reused: created.reused } };
    }
    const rawLog = body.log;
    if (typeof rawLog !== "string") throw new RouteError(400, "invalid_input", "log (base64) is required");
    const bytes = Uint8Array.from(Buffer.from(rawLog, "base64"));
    const created = withMappedErrors(() =>
      deps.service.createTask({
        requestId,
        log: bytes,
        requestText: typeof body.requestText === "string" ? body.requestText : undefined,
        executorId: typeof body.executorId === "string" ? body.executorId : undefined,
      }),
    );
    return { status: 201, body: { taskId: created.taskId, status: created.status, reused: created.reused } };
  });

  router.add("GET", "/api/tasks/:id", (context) => {
    const taskId = context.params.id!;
    return { body: withMappedErrors(() => deps.service.getTask(taskId)) };
  });

  router.add("PATCH", "/api/tasks/:id", (context) => {
    const taskId = context.params.id!;
    const body = asRecord(context.body);
    const patch: { title?: string | null; archived?: boolean } = {};
    if ("title" in body) {
      if (body.title !== null && typeof body.title !== "string") {
        throw new RouteError(400, "invalid_input", "title must be a string or null");
      }
      patch.title = body.title;
    }
    if ("archived" in body) {
      if (typeof body.archived !== "boolean") {
        throw new RouteError(400, "invalid_input", "archived must be a boolean");
      }
      patch.archived = body.archived;
    }
    return { body: withMappedErrors(() => deps.service.updateTask(taskId, patch)) };
  });

  router.add("DELETE", "/api/tasks/:id", async (context) => {
    const taskId = context.params.id!;
    const body = asRecord(context.body);
    const force = context.query.get("force") === "1" || context.query.get("force") === "true" || body.force === true;
    try {
      const result = await deps.service.deleteTask(taskId, {
        force,
        workspaces: deps.workspaces,
        runStreams: deps.runStreams,
        mcpGateway: deps.mcpGateway,
        interruptActive: deps.interruptActive,
      });
      return { body: result };
    } catch (error) {
      throw toRouteError(error);
    }
  });

  router.add("GET", "/api/tasks/:id/events", (context) => {
    const taskId = context.params.id!;
    const afterSeq = parseNonNegativeInt(context.query.get("afterSeq"), 0);
    const wantsJson = context.query.get("format") === "json" || !context.accept.includes("text/event-stream");
    if (wantsJson) {
      const limit = parsePositiveInt(context.query.get("limit"), 500);
      return { body: { events: deps.ledger.forTask(taskId, afterSeq, limit) } };
    }
    return {
      stream: async (res, signal) => {
        await streamEvents(deps, res, signal, { afterSeq, heartbeatMs, filter: (event) => event.taskId === taskId });
      },
    };
  });

  router.add("GET", "/api/events", (context) => {
    return {
      stream: async (res, signal) => {
        const afterSeq = parseNonNegativeInt(context.query.get("afterSeq"), 0);
        await streamEvents(deps, res, signal, { afterSeq, heartbeatMs });
      },
    };
  });

  router.add("POST", "/api/tasks/:id/amend", (context) => {
    const taskId = context.params.id!;
    const body = asRecord(context.body);
    const expected = body.expectedBriefVersion;
    if (typeof expected !== "number" || !Number.isInteger(expected)) {
      throw new RouteError(400, "invalid_input", "expectedBriefVersion (integer) is required");
    }
    const result = withMappedErrors(() =>
      deps.service.amendTask(taskId, {
        expectedBriefVersion: expected,
        goal: optionalString(body.goal),
        must: optionalStringArray(body.must),
        mustNot: optionalStringArray(body.mustNot),
        evidence: optionalStringArray(body.evidence),
        requestText: optionalString(body.requestText),
      }),
    );
    return { body: { taskId, briefVersion: result.briefVersion } };
  });

  router.add("POST", "/api/tasks/:id/stop", (context) => {
    const taskId = context.params.id!;
    const body = asRecord(context.body);
    const result = withMappedErrors(() =>
      deps.service.stopTask(taskId, { reason: optionalString(body.reason) }),
    );
    // The final `stopped` transition follows once the interrupt is acknowledged.
    return { status: 202, body: { taskId, status: result.status } };
  });

  router.add("POST", "/api/tasks/:id/retry", (context) => {
    const taskId = context.params.id!;
    const body = asRecord(context.body);
    const result = withMappedErrors(() =>
      deps.service.retryTask(taskId, {
        executorId: optionalString(body.executorId),
        model: optionalString(body.model),
      }),
    );
    return { status: 202, body: result };
  });

  // ---- Step 2.1: standing policy, attention firewall, two-phase proposals ----

  router.add("GET", "/api/inbox", () => ({
    body: { items: deps.service.listInbox() },
  }));

  router.add("POST", "/api/inbox/:taskId/:decisionKey/dismiss", (context) => {
    const taskId = context.params.taskId!;
    const rawKey = context.params.decisionKey!;
    if (rawKey !== "decision_required" && rawKey !== "delivery_verified" && rawKey !== "task_blocked_final") {
      throw new RouteError(400, "invalid_input", `unknown decisionKey: ${rawKey}`);
    }
    return { body: withMappedErrors(() => deps.service.dismissInboxItem(taskId, rawKey)) };
  });

  router.add("GET", "/api/policy", () => ({
    body: withMappedErrors(() => deps.service.policySnapshot()),
  }));

  router.add("POST", "/api/tasks/:id/authorize", (context) => {
    const taskId = context.params.id!;
    const body = asRecord(context.body);
    const action = requireString(body.action, "action");
    const result = withMappedErrors(() =>
      deps.service.requestAuthorization(taskId, {
        action,
        environment: optionalString(body.environment) ?? null,
        resource: optionalString(body.resource) ?? null,
      }),
    );
    return { body: { taskId, ...result } };
  });

  router.add("POST", "/api/tasks/:id/authorize/resolve", (context) => {
    const taskId = context.params.id!;
    const body = asRecord(context.body);
    const action = requireString(body.action, "action");
    const approved = body.approved;
    if (typeof approved !== "boolean") throw new RouteError(400, "invalid_input", "approved (boolean) is required");
    const result = withMappedErrors(() =>
      deps.service.resolveAuthorization(taskId, { action, approved, reason: optionalString(body.reason) }),
    );
    return { body: { taskId, ...result } };
  });

  router.add("GET", "/api/tasks/:id/proposals", (context) => {
    const taskId = context.params.id!;
    return { body: { proposals: withMappedErrors(() => deps.service.listProposals(taskId)) } };
  });

  router.add("POST", "/api/tasks/:id/proposals", (context) => {
    const taskId = context.params.id!;
    const body = asRecord(context.body);
    const kind = body.kind === "grant" ? "grant" : "brief";
    let diff = Array.isArray(body.diff)
      ? body.diff.filter(
          (item): item is { field: string; before: string; after: string } =>
            !!item && typeof item === "object" && typeof (item as { field?: unknown }).field === "string",
        )
      : [];
    let briefPayload = body.brief;
    // Shorthand: allow callers (like the web UI) to propose a new `goal` and
    // auto-compute the full brief + before/after diff against the current brief.
    if (kind === "brief" && !briefPayload && typeof body.goal === "string" && body.goal.trim() !== "") {
      const current = withMappedErrors(() => deps.service.getBrief(taskId));
      const nextGoal = body.goal.trim();
      briefPayload = { ...current, goal: nextGoal };
      if (diff.length === 0) diff = [{ field: "goal", before: current.goal, after: nextGoal }];
    }
    const change = {
      kind,
      diff,
      ...(kind === "brief" && briefPayload ? { brief: briefPayload } : {}),
      ...(kind === "grant" && Array.isArray(body.grants) ? { grants: body.grants } : {}),
    } as Parameters<TaskService["proposeChange"]>[1]["change"];
    const proposal = withMappedErrors(() => deps.service.proposeChange(taskId, { change, reason: optionalString(body.reason) ?? "proposed change" }));
    // A proposal never mutates the task: it only surfaces a diff card.
    return { status: 201, body: proposal };
  });

  router.add("POST", "/api/proposals/:pid/confirm", (context) => {
    return { body: withMappedErrors(() => deps.service.confirmProposal(context.params.pid!)) };
  });

  router.add("POST", "/api/proposals/:pid/cancel", (context) => {
    return { body: withMappedErrors(() => deps.service.cancelProposal(context.params.pid!)) };
  });

  // ---- Step 3.2: Live RunStream NDJSON replay/SSE & live steering ----

  router.add("GET", "/api/tasks/:id/runs", (context) => {
    const taskId = context.params.id!;
    withMappedErrors(() => deps.service.getTask(taskId));
    return { body: { taskId, runs: deps.runStreams?.listRuns(taskId) ?? [] } };
  });

  router.add("GET", "/api/tasks/:id/runs/:runId/stream", (context) => {
    const taskId = context.params.id!;
    const runId = context.params.runId!;
    const afterSeq = parseNonNegativeInt(context.query.get("afterSeq"), 0);
    const wantsJson = context.query.get("format") === "json" || !context.accept.includes("text/event-stream");
    if (wantsJson) {
      return { body: { taskId, runId, events: deps.runStreams?.read(taskId, runId, afterSeq) ?? [] } };
    }
    return {
      stream: async (res, signal) => {
        await streamRunEvents(deps.runStreams, res, signal, { taskId, runId, afterSeq, heartbeatMs });
      },
    };
  });

  router.add("POST", "/api/tasks/:id/steer", async (context) => {
    const taskId = context.params.id!;
    withMappedErrors(() => deps.service.getTask(taskId));
    const body = asRecord(context.body);
    const message = requireString(body.message, "message");
    if (!deps.steer) {
      return { body: { taskId, accepted: false, runId: null, reason: "steering is not enabled on this server" } };
    }
    const result = await deps.steer(taskId, message);
    return { body: { taskId, ...result } };
  });

  // ---- Step 4.2 / 5.2: Operation reconciliation & human resolution for effect_unknown ----

  router.add("POST", "/api/operations/:opId/reconcile", async (context) => {
    if (!deps.reconcileOperation) {
      throw new RouteError(501, "unsupported", "operation reconciliation is not configured");
    }
    const opId = context.params.opId!;
    try {
      const result = await deps.reconcileOperation(opId);
      return { body: result };
    } catch (error) {
      throw toRouteError(error);
    }
  });

  router.add("POST", "/api/operations/:opId/resolve", (context) => {
    if (!deps.resolveOperation) {
      throw new RouteError(501, "unsupported", "operation resolution is not configured");
    }
    const opId = context.params.opId!;
    const body = asRecord(context.body);
    const resolution = body.resolution === "confirmed_exists" || body.resolution === "confirmed_absent" ? body.resolution : null;
    if (!resolution) {
      throw new RouteError(400, "invalid_input", "resolution must be confirmed_exists or confirmed_absent");
    }
    return {
      body: withMappedErrors(() =>
        deps.resolveOperation!(opId, {
          resolution,
          mrId: optionalString(body.mrId),
          url: optionalString(body.url),
          headSha: optionalString(body.headSha),
          reason: optionalString(body.reason),
        }),
      ),
    };
  });

  // ---- Step 5.1: Immutable g1 -> g2 executor handoff ----

  router.add("POST", "/api/tasks/:id/handoff", async (context) => {
    if (!deps.handoff) {
      throw new RouteError(501, "unsupported", "executor handoff is not configured");
    }
    const taskId = context.params.id!;
    const body = asRecord(context.body);
    const executorId = requireString(body.executorId, "executorId");
    try {
      const result = await deps.handoff(taskId, {
        executorId,
        model: optionalString(body.model),
        reason: optionalString(body.reason),
      });
      return { status: 200, body: result };
    } catch (error) {
      throw toRouteError(error);
    }
  });
}

async function streamChatFrames(
  chatBus: ChatStreamBus | undefined,
  res: import("node:http").ServerResponse,
  signal: AbortSignal,
  heartbeatMs: number,
): Promise<void> {
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders?.();
  if (!chatBus) {
    res.end();
    return;
  }
  const write = (frame: ChatStreamFrame) => {
    if (signal.aborted || res.writableEnded) return;
    res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
  };
  const unsubscribe = chatBus.subscribe(write);
  const heartbeat = setInterval(() => {
    if (signal.aborted || res.writableEnded) return;
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      res.on("close", () => resolve());
    });
  } finally {
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) res.end();
  }
}

async function streamRunEvents(
  runStreams: RunStreamStore | undefined,
  res: import("node:http").ServerResponse,
  signal: AbortSignal,
  options: { taskId: string; runId: string; afterSeq: number; heartbeatMs: number },
): Promise<void> {
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders?.();
  if (!runStreams) {
    res.end();
    return;
  }
  let last = options.afterSeq;
  const write = (event: RunStreamEvent) => {
    if (event.seq <= last) return;
    last = event.seq;
    res.write(`id: ${event.seq}\nevent: run_event\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const pending: RunStreamEvent[] = [];
  let replaying = true;
  const unsubscribe = runStreams.subscribe(options.taskId, options.runId, (event) => {
    if (replaying) pending.push(event);
    else write(event);
  });
  try {
    for (const event of runStreams.read(options.taskId, options.runId, options.afterSeq)) write(event);
    replaying = false;
    for (const event of pending) write(event);
    pending.length = 0;

    const heartbeat = setInterval(() => {
      if (signal.aborted) return;
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, options.heartbeatMs);
    heartbeat.unref?.();

    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      res.on("close", () => resolve());
    });
    clearInterval(heartbeat);
  } finally {
    replaying = false;
    unsubscribe();
    if (!res.writableEnded) res.end();
  }
}

interface StreamOptions {
  afterSeq: number;
  heartbeatMs: number;
  filter?: (event: TaskEvent) => boolean;
}

/**
 * Replays `seq > afterSeq` first, then forwards live bus events. The client's
 * `lastSeq` therefore never skips an event: the replay and the subscription are
 * installed before the first read, and duplicates are dropped by sequence.
 */
async function streamEvents(
  deps: ApiDeps,
  res: import("node:http").ServerResponse,
  signal: AbortSignal,
  options: StreamOptions,
): Promise<void> {
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders?.();
  let last = options.afterSeq;

  const write = (event: TaskEvent) => {
    if (event.seq <= last) return;
    if (options.filter && !options.filter(event)) {
      last = event.seq;
      return;
    }
    last = event.seq;
    res.write(`id: ${event.seq}\nevent: task_event\ndata: ${JSON.stringify(event)}\n\n`);
  };

  // Subscribe first so an event committed during replay is not lost; the
  // sequence guard makes the overlap harmless.
  const pending: TaskEvent[] = [];
  let replaying = true;
  const unsubscribe = deps.bus.on("*", (event) => {
    if (replaying) pending.push(event);
    else write(event);
  });

  try {
    // Page through history so a backlog larger than one batch is never truncated
    // (the ledger read has a hard per-call limit).
    const batchSize = 500;
    let cursor = options.afterSeq;
    for (;;) {
      const batch = deps.ledger.afterSeq(cursor, batchSize);
      for (const event of batch) write(event);
      if (batch.length < batchSize) break;
      cursor = batch[batch.length - 1]!.seq;
    }
    replaying = false;
    for (const event of pending) write(event);
    pending.length = 0;

    const heartbeat = setInterval(() => {
      if (signal.aborted) return;
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, options.heartbeatMs);
    heartbeat.unref?.();

    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      res.on("close", () => resolve());
    });
    clearInterval(heartbeat);
  } finally {
    replaying = false;
    unsubscribe();
    if (!res.writableEnded) res.end();
  }
}

/** Maps application errors to HTTP status codes and stable error codes. */
export function withMappedErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw toRouteError(error);
  }
}

export function toRouteError(error: unknown): RouteError {
  if (error instanceof RouteError) return error;
  if (error instanceof TaskNotFoundError) return new RouteError(404, "not_found", error.message);
  if (error instanceof TaskConflictError) return new RouteError(409, error.code, error.message, error.details);
  if (error instanceof ProposalConflictError) return new RouteError(409, error.code, error.message);
  if (error instanceof RequestConflictError) return new RouteError(409, "request_conflict", error.message);
  if (error instanceof InvalidInputError) return new RouteError(400, "invalid_input", error.message);
  if (error instanceof CommandError) {
    const status = error.code === "not_found" ? 404 : error.code === "request_conflict" ? 409 : error.code === "unsupported" ? 405 : 400;
    return new RouteError(status, error.code, error.message);
  }
  return new RouteError(500, "internal", error instanceof Error ? error.message : String(error));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new RouteError(400, "invalid_input", `${field} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseNonNegativeInt(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}
