import { closeSync, openSync, writeSync } from "node:fs";
import { constants } from "node:fs";
import type { ServiceConfig, T3RuntimeConfig } from "../config.js";
import { defaultConfig } from "../config.js";
import { ensureHome, resolveHome } from "../home.js";
import { loadPolicyFile, resolveT3Config } from "../settings.js";
import { TaskService } from "./task-service.js";
import { TaskStore } from "../store/tasks.js";
import { ArtifactStore } from "../store/artifacts.js";
import { TaskRunner } from "./runner.js";
import { createMcpT3Client } from "../adapters/t3.js";
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
    log,
  });

  const router = new Router();
  registerApi(router, {
    service,
    ledger: writer.ledger,
    bus,
    startedAt: new Date().toISOString(),
    t3Configured: t3 !== null,
  });

  const listeners: RunningListener[] = [];
  try {
    listeners.push(await startListener({ router, target: { socketPath: config.socketPath }, onError: (error) => log(`unix socket: ${String(error)}`) }));
    log(`listening on unix socket ${config.socketPath}`);

    const httpPort = Number(env.TIMO_HTTP_PORT);
    if (Number.isInteger(httpPort) && httpPort > 0) {
      const token = env.TIMO_SESSION_TOKEN?.trim() || newSessionToken();
      const webDir = resolveWebDir(home);
      const webRouter = new Router();
      registerApi(webRouter, {
        service,
        ledger: writer.ledger,
        bus,
        startedAt: new Date().toISOString(),
        t3Configured: t3 !== null,
      });
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
    for (const listener of listeners.reverse()) await listener.close().catch(() => undefined);
    service.close();
    lock.release();
    throw error instanceof ServiceUnavailableError ? error : new ServiceUnavailableError(String(error));
  }

  runner.start();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log(`received ${signal}, stopping`);
    await runner.stop();
    for (const listener of listeners.reverse()) await listener.close().catch(() => undefined);
    lock.release();
    service.close();
    closeSync(logFd);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise<void>(() => undefined);
}
