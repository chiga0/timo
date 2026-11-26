import { openSync, closeSync, writeSync } from "node:fs";
import { constants } from "node:fs";
import type { ServiceConfig, T3RuntimeConfig } from "../config.js";
import { defaultConfig } from "../config.js";
import { ensureHome, resolveHome } from "../home.js";
import { resolveT3Config } from "../settings.js";
import { TaskService, TaskNotFoundError, InvalidInputError } from "./task-service.js";
import { RequestConflictError, TaskStore } from "../store/tasks.js";
import { ArtifactStore } from "../store/artifacts.js";
import { TaskRunner } from "./runner.js";
import { createMcpT3Client } from "../adapters/t3.js";
import { startServiceServer, CommandError, ServiceUnavailableError, type WireRequest, type WireResponse } from "../ipc.js";

/**
 * Foreground task service. Data lives under TIMO_HOME; the CLI reaches it over
 * a Unix socket. A second instance refuses to start.
 */
export async function serve(): Promise<void> {
  const env = process.env;
  const home = resolveHome(env);
  ensureHome(home);
  const config: ServiceConfig = defaultConfig(env, home);
  const t3: T3RuntimeConfig | null = resolveT3Config(env, home);

  const { service, db } = TaskService.open(config);
  const logFd = openSync(`${home}/service.log`, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
  const log = (line: string) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    process.stderr.write(text);
    writeSync(logFd, text);
  };
  log(`timo serve: home=${home} t3=${t3 ? "configured" : "unconfigured"}`);

  const store = new TaskStore(db);
  const artifacts = ArtifactStore.create(home);
  const runner = new TaskRunner({
    store,
    service,
    artifacts,
    t3,
    clientFactory: (clientConfig) => Promise.resolve(createMcpT3Client(clientConfig)),
    pollIntervalMs: config.pollIntervalMs,
    waitTimeoutMs: config.waitTimeoutMs,
    runDeadlineMs: config.runDeadlineMs,
    log,
  });

  const server = await startServiceServer(config, async (request) => {
    try {
      return { id: request.id, ok: true, result: dispatch(request) };
    } catch (error) {
      return toErrorResponse(request, error);
    }
  });

  function dispatch(request: WireRequest): unknown {
    switch (request.command) {
      case "create": {
        const rawLog = request.params.log;
        if (typeof rawLog !== "string") throw new CommandError("invalid_input", "log bytes are required");
        const bytes = Uint8Array.from(Buffer.from(rawLog, "base64"));
        const requestText = typeof request.params.requestText === "string" ? request.params.requestText : undefined;
        const created = service.createTask({ requestId: String(request.params.requestId ?? ""), log: bytes, requestText });
        return { taskId: created.taskId, status: created.status };
      }
      case "get":
        return service.getTask(String(request.params.taskId ?? ""));
      default:
        throw new CommandError("unsupported", `unknown command ${request.command}`);
    }
  }

  runner.start();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log(`received ${signal}, stopping`);
    await runner.stop();
    await server.close().catch(() => undefined);
    service.close();
    closeSync(logFd);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise<void>(() => undefined);
}

function toErrorResponse(request: WireRequest, error: unknown): WireResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TaskNotFoundError) return { id: request.id, ok: false, error: { code: "not_found", message } };
  if (error instanceof RequestConflictError) return { id: request.id, ok: false, error: { code: "request_conflict", message } };
  if (error instanceof InvalidInputError) return { id: request.id, ok: false, error: { code: "invalid_input", message } };
  if (error instanceof CommandError) return { id: request.id, ok: false, error: { code: error.code, message } };
  if (error instanceof ServiceUnavailableError) return { id: request.id, ok: false, error: { code: "service_unavailable", message } };
  return { id: request.id, ok: false, error: { code: "internal", message } };
}
