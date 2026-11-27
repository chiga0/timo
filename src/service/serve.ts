import { join } from "node:path";
import { closeSync, openSync, writeSync } from "node:fs";
import { constants } from "node:fs";
import type { ServiceConfig, T3RuntimeConfig } from "../config.js";
import { defaultConfig } from "../config.js";
import { ensureHome, resolveHome } from "../home.js";
import { loadPolicyFile, resolveT3Config, SettingsStore } from "../settings.js";
import { TaskService } from "./task-service.js";
import { TaskStore } from "../store/tasks.js";
import { ArtifactStore } from "../store/artifacts.js";
import { TaskRunner } from "./runner.js";
import { createMcpT3Client } from "../adapters/t3.js";
import { ExecutorRegistry } from "../adapters/execution.js";
import { PiAdapter } from "../adapters/pi.js";
import { QwenCodeAdapter } from "../adapters/qwen-code.js";
import { CodexAdapter } from "../adapters/codex.js";
import { OpenCodeAdapter } from "../adapters/opencode.js";
import { T3ExecutionAdapter } from "../adapters/t3-adapter.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { RunStreamStore } from "../workspace/run-stream.js";
import { ChatStore, ChatStreamBus } from "../store/chat.js";
import { MainChatRunner } from "./chat-runner.js";
import { CapabilityMcpGateway } from "../gateway/mcp-gateway.js";
import {
  createPlatformMrVerifier,
  reconcileMrOperation,
  registerPlatformTools,
  registerWorkspaceTools,
  resolveMrOperation,
} from "../gateway/tools.js";
import { DynamicPlatformAdapter, EnterpriseGitPlatformAdapter } from "../platform/adapter.js";
import { acquireServiceLock, ServiceUnavailableError } from "../ipc.js";
import { Router, newSessionToken, startListener, type RunningListener } from "../http/server.js";
import { registerWeb, resolveWebDir } from "../http/web.js";
import { registerApi } from "../http/routes.js";

/**
 * Foreground task service. Data lives under TIMO_HOME. Two listeners share one
 * router: the Unix socket for the local CLI (trusted by file mode 0600) and,
 * optionally, a loopback port for the Web console that requires a session token.
 */
export async function serve(): Promise<void> {
  const env = process.env;
  const home = resolveHome(env);
  ensureHome(home);
  const config: ServiceConfig = defaultConfig(env, home);
  const t3: T3RuntimeConfig | null = resolveT3Config(env, home);
  // A missing or broken policy.json falls back to the safe defaults.
  const policy = loadPolicyFile(home);

  // Claim the single-instance lock before binding anything.
  const lock = acquireServiceLock(config.socketPath);

  const { service, db, bus, writer } = TaskService.open(config, { policy });
  const logFd = openSync(`${home}/service.log`, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
  const log = (line: string) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    process.stderr.write(text);
    writeSync(logFd, text);
  };
  log(`timo serve: home=${home} t3=${t3 ? "configured" : "unconfigured"}`);

  const store = new TaskStore(db);
  const artifacts = ArtifactStore.create(home);
  const workspaces = new WorkspaceManager({ home: join(home, "workspaces") });
  const runStreams = new RunStreamStore(home);
  const chatStore = new ChatStore(db);
  const chatBus = new ChatStreamBus();
  // Forward meaningful live worker progress to Main Chat so embedded Task Cards
  // update in real time with a single clean status line (never raw token spam).
  runStreams.subscribeAll((event) => {
    if (event.type === "text_delta" || event.summary.trim() === "") return;
    chatBus.publish({
      event: "task_progress",
      data: { taskId: event.taskId, runId: event.runId, type: event.type, summary: event.summary, at: event.at },
    });
  });
  const executors = new ExecutorRegistry();
  // Register the 4 resident native CLI agents: pi, qwen-code, codex, opencode (+ optional t3).
  executors.register(new PiAdapter());
  executors.register(new QwenCodeAdapter());
  executors.register(new CodexAdapter());
  executors.register(new OpenCodeAdapter());
  if (t3) {
    executors.register(new T3ExecutionAdapter({ clientFactory: () => Promise.resolve(createMcpT3Client(t3)) }));
  }
  const probed = await executors.probeAll();
  log(`executors probed: ${probed.map((e) => `${e.id}=${e.available ? "ready" : "unavailable"}`).join(", ")}`);

  // Workspace, assistant, knowledge base & isolated credentials store.
  const settingsStore = new SettingsStore(home, env);
  const chatRunner = new MainChatRunner({
    home,
    chatStore,
    chatBus,
    service,
    executors,
    settingsStore,
    log,
  });

  // Local Capability MCP Gateway (Step 4.1 + 4.2): holds platform credentials
  // strictly inside the gateway process, never exposed to Worker subprocesses.
  const platform = new DynamicPlatformAdapter((repo) => {
    const userSettings = settingsStore.load();
    const matchedProject = userSettings.projects.find((p) => p.remoteRepo === repo || p.name === repo);
    const matchedFolder = (userSettings.folders ?? []).find((f) => f.remoteRepo === repo || f.name === repo);
    const conn =
      (matchedProject?.platformId ? userSettings.connections.find((c) => c.id === matchedProject.platformId) : undefined) ??
      (matchedFolder?.remoteHost
        ? userSettings.connections.find((c) => c.baseUrl.includes(matchedFolder.remoteHost!))
        : undefined) ??
      userSettings.connections.find((c) => c.kind === "enterprise_git" || c.kind === "gitlab");
    if (conn && (conn.kind === "enterprise_git" || conn.kind === "gitlab")) {
      return new EnterpriseGitPlatformAdapter({
        baseUrl: conn.baseUrl,
        apiPath: conn.apiPath,
        authHeader: conn.authHeader,
        credentialKey: conn.credentialKey,
      });
    }
    return null;
  });
  const mcpPort = Number(env.TIMO_MCP_PORT);
  const mcpGateway = new CapabilityMcpGateway({
    service,
    port: Number.isInteger(mcpPort) && mcpPort > 0 ? mcpPort : 0,
    credentialsProvider: () => settingsStore.resolveGatewayCredentials(),
    onError: (error) => log(`mcp gateway: ${String(error)}`),
  });
  registerPlatformTools(mcpGateway, { store, service, platform });
  registerWorkspaceTools(mcpGateway, { settingsStore, workspaces });
  const mcpBound = await mcpGateway.start();
  log(`capability mcp gateway listening on http://${mcpBound.host}:${mcpBound.port}/mcp/:taskId/:generation/:nonce`);

  const runner = new TaskRunner({
    store,
    service,
    artifacts,
    writer,
    bus,
    t3,
    clientFactory: (clientConfig) => Promise.resolve(createMcpT3Client(clientConfig)),
    pollIntervalMs: config.pollIntervalMs,
    waitTimeoutMs: config.waitTimeoutMs,
    runDeadlineMs: config.runDeadlineMs,
    runStreams,
    executors,
    workspaces,
    verifiers: service.verifiers,
    mcpGateway,
    platformVerifier: createPlatformMrVerifier({ store, service, platform, credentials: settingsStore.resolveGatewayCredentials() }),
    enableWatchdogTriage: true,
    settingsStore,
    log,
  });

  const startedAt = new Date().toISOString();
  const apiDeps = {
    service,
    ledger: writer.ledger,
    bus,
    startedAt,
    t3Configured: t3 !== null,
    executors,
    runStreams,
    settingsStore,
    workspaces,
    mcpGateway,
    chatStore,
    chatBus,
    chatRunner,
    interruptActive: (id: string) => runner.interruptTask(id),
    steer: (taskId: string, message: string) => runner.steerTask(taskId, message),
    reconcileOperation: (operationId: string) =>
      reconcileMrOperation(operationId, { store, service, platform, credentials: settingsStore.resolveGatewayCredentials() }),
    resolveOperation: (
      operationId: string,
      input: { resolution: "confirmed_exists" | "confirmed_absent"; mrId?: string; url?: string; headSha?: string; reason?: string },
    ) => resolveMrOperation(operationId, input, { store, service }),
    handoff: (taskId: string, input: { executorId: string; model?: string; reason?: string }) => {
      // Validate requested executor is registered & ready before migrating!
      executors.require(input.executorId);
      return service.handoffTask(taskId, {
        toExecutor: input.executorId,
        model: input.model,
        reason: input.reason,
        workspaces,
        mcpGateway,
        interruptActive: (id) => runner.interruptTask(id),
      });
    },
  };

  const router = new Router();
  registerApi(router, apiDeps);

  const listeners: RunningListener[] = [];
  try {
    listeners.push(await startListener({ router, target: { socketPath: config.socketPath }, onError: (error) => log(`unix socket: ${String(error)}`) }));
    log(`listening on unix socket ${config.socketPath}`);

    const httpPort = Number(env.TIMO_HTTP_PORT);
    if (Number.isInteger(httpPort) && httpPort > 0) {
      const token = env.TIMO_SESSION_TOKEN?.trim() || newSessionToken();
      const webDir = resolveWebDir(home);
      const webRouter = new Router();
      registerApi(webRouter, apiDeps);
      registerWeb(webRouter, webDir, token);
      const loopback = await startListener({
        router: webRouter,
        target: { host: "127.0.0.1", port: httpPort },
        token,
        onError: (error) => log(`loopback: ${String(error)}`),
      });
      listeners.push(loopback);
      // The token goes to the log for the operator, never into the task database.
      log(`loopback http://127.0.0.1:${loopback.port} session token ${token}`);
      // The bundle URL carries the token once; the page stores it as a cookie.
      log(`web http://127.0.0.1:${loopback.port}/?token=${token}`);
      if (webDir) log(`web bundle served from ${webDir}`);
      else log("web bundle not found; run `npm run build:web` to build it");
      if (env.TIMO_SESSION_TOKEN) log("session token taken from TIMO_SESSION_TOKEN");
    }
  } catch (error) {
    await mcpGateway.close().catch(() => undefined);
    for (const listener of listeners.reverse()) await listener.close().catch(() => undefined);
    service.close();
    lock.release();
    throw error instanceof ServiceUnavailableError ? error : new ServiceUnavailableError(String(error));
  }

  runner.start();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) {
      log(`received second ${signal}, forcing immediate exit`);
      try { lock.release(); } catch { /* ignore */ }
      process.exit(130);
    }
    closing = true;
    log(`received ${signal}, stopping (press Ctrl+C again to force exit)`);
    const forceTimer = setTimeout(() => {
      log("shutdown timed out after 3.5s, forcing exit");
      try { lock.release(); } catch { /* ignore */ }
      process.exit(130);
    }, 3_500);
    forceTimer.unref?.();

    const withTimeout = <T>(promise: Promise<T>, ms: number) =>
      Promise.race([promise.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, ms))]);

    await withTimeout(chatRunner.stop(), 1_000);
    await withTimeout(runner.stop(2_500), 2_800);
    await withTimeout(mcpGateway.close(), 500);
    for (const listener of listeners.reverse()) {
      await withTimeout(listener.close(), 500);
    }
    clearTimeout(forceTimer);
    try { lock.release(); } catch { /* ignore */ }
    try { service.close(); } catch { /* ignore */ }
    try { closeSync(logFd); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise<void>(() => undefined);
}
