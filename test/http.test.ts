import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/service/task-service.js";
import { defaultConfig } from "../src/config.js";
import { acquireServiceLock } from "../src/ipc.js";
import { Router, newSessionToken, startListener } from "../src/http/server.js";
import { registerApi } from "../src/http/routes.js";

const log = () => new TextEncoder().encode("2026-11-26T00:00:01Z alpha CONNECT\n2026-11-26T00:00:02Z alpha DISCONNECT\n");

interface Api {
  home: string;
  service: TaskService;
  base: string;
  token: string;
  socketPath: string;
  stop: () => Promise<void>;
}

/** Boots both listeners against one TIMO_HOME, exactly as `timo serve` does. */
async function boot(): Promise<Api> {
  const home = mkdtempSync(join(tmpdir(), "timo-http-"));
  const config = defaultConfig({}, home);
  const lock = acquireServiceLock(config.socketPath);
  const { service, writer, bus } = TaskService.open(config);
  const token = newSessionToken();
  const deps = { service, ledger: writer.ledger, bus, startedAt: new Date().toISOString(), t3Configured: false, heartbeatMs: 50 };

  const socketRouter = new Router();
  registerApi(socketRouter, deps);
  const socketListener = await startListener({ router: socketRouter, target: { socketPath: config.socketPath } });

  const tcpRouter = new Router();
  registerApi(tcpRouter, deps);
  const tcpListener = await startListener({ router: tcpRouter, target: { host: "127.0.0.1", port: 0 }, token });

  return {
    home,
    service,
    base: `http://127.0.0.1:${tcpListener.port}`,
    token,
    socketPath: config.socketPath,
    stop: async () => {
      await tcpListener.close();
      await socketListener.close();
      service.close();
      lock.release();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

interface Result {
  status: number;
  body: unknown;
}

function httpJson(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const payload = init.body === undefined ? undefined : Buffer.from(JSON.stringify(init.body), "utf8");
    const req = request(
      url,
      {
        method: init.method ?? "GET",
        headers: {
          ...(init.headers ?? {}),
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: text === "" ? undefined : JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function socketJson(socketPath: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const payload = init.body === undefined ? undefined : Buffer.from(JSON.stringify(init.body), "utf8");
    const req = request(
      {
        socketPath,
        path,
        method: init.method ?? "GET",
        headers: payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: text === "" ? undefined : JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Collects SSE `data:` frames until `want` events arrived, then tears the stream
 * down. Always settles: a timeout, an upstream close, or a client error ends it,
 * so a test can never hang the runner on a lingering subscription.
 */
function readSseUntil(url: string, token: string, want: number, timeoutMs = 3_000): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const events: Array<Record<string, unknown>> = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      if (error) reject(error);
      else resolve(events);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    timer.unref?.();
    const req = request(url, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } }, (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("");
          if (!data) continue;
          events.push(JSON.parse(data) as Record<string, unknown>);
          if (events.length >= want) {
            finish();
            return;
          }
        }
      });
      res.on("end", () => finish());
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      // Destroying the client ourselves surfaces as ECONNRESET/aborted.
      if (settled || error.code === "ECONNRESET" || error.code === "ERR_STREAM_PREMATURE_CLOSE") return;
      finish(error);
    });
    req.end();
  });
}

const create = (api: Api, requestId: string, headers: Record<string, string> = { authorization: `Bearer ${api.token}` }) =>
  httpJson(`${api.base}/api/tasks`, {
    method: "POST",
    headers,
    body: { requestId, log: Buffer.from(log()).toString("base64") },
  });

test("loopback API rejects a missing or wrong session token", async () => {
  const api = await boot();
  try {
    const missing = await httpJson(`${api.base}/api/health`);
    assert.equal(missing.status, 401);
    const wrong = await httpJson(`${api.base}/api/health`, { headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
    const good = await httpJson(`${api.base}/api/health`, { headers: { authorization: `Bearer ${api.token}` } });
    assert.equal(good.status, 200);
    // The Unix socket is the trust boundary itself, so it needs no token.
    const viaSocket = await socketJson(api.socketPath, "/api/health");
    assert.equal(viaSocket.status, 200);
  } finally {
    await api.stop();
  }
});

test("CLI path over the Unix socket: create, list, get", async () => {
  const api = await boot();
  try {
    const created = await socketJson(api.socketPath, "/api/tasks", {
      method: "POST",
      body: { requestId: "sock-1", log: Buffer.from(log()).toString("base64") },
    });
    assert.equal(created.status, 201);
    const taskId = (created.body as { taskId: string }).taskId;

    const list = await socketJson(api.socketPath, "/api/tasks");
    assert.equal(list.status, 200);
    assert.ok((list.body as { tasks: Array<{ taskId: string }> }).tasks.some((task) => task.taskId === taskId));

    const fetched = await socketJson(api.socketPath, `/api/tasks/${taskId}`);
    assert.equal(fetched.status, 200);
    assert.equal((fetched.body as { taskId: string }).taskId, taskId);
  } finally {
    await api.stop();
  }
});

test("stale amend version returns 409 and leaves the brief untouched", async () => {
  const api = await boot();
  try {
    const created = await create(api, "amend-1");
    const taskId = (created.body as { taskId: string }).taskId;

    const ok = await httpJson(`${api.base}/api/tasks/${taskId}/amend`, {
      method: "POST",
      headers: { authorization: `Bearer ${api.token}` },
      body: { expectedBriefVersion: 1, goal: "新的目标：核对断连并给出恢复窗口" },
    });
    assert.equal(ok.status, 200);
    assert.equal((ok.body as { briefVersion: number }).briefVersion, 2);

    // The stale writer still thinks the task is at version 1.
    const stale = await httpJson(`${api.base}/api/tasks/${taskId}/amend`, {
      method: "POST",
      headers: { authorization: `Bearer ${api.token}` },
      body: { expectedBriefVersion: 1, goal: "过期写入不应生效" },
    });
    assert.equal(stale.status, 409);
    assert.equal(((stale.body as { error: { code: string } }).error).code, "version_conflict");

    const view = api.service.getTask(taskId);
    assert.equal(view.taskId, taskId);
    // The rejected amendment must not have overwritten the accepted one.
    const audits = api.service.ledger.forTask(taskId).filter((event) => event.type === "task_amended");
    assert.equal(audits.length, 1);
    assert.equal((audits[0]!.payload as { brief: { goal: string } }).brief.goal, "新的目标：核对断连并给出恢复窗口");
  } finally {
    await api.stop();
  }
});

test("amend cannot touch a terminal task", async () => {
  const api = await boot();
  try {
    const created = await create(api, "amend-2");
    const taskId = (created.body as { taskId: string }).taskId;
    api.service.stopTask(taskId);
    api.service.markStopped(taskId, { interrupted: true });
    const res = await httpJson(`${api.base}/api/tasks/${taskId}/amend`, {
      method: "POST",
      headers: { authorization: `Bearer ${api.token}` },
      body: { expectedBriefVersion: 1, goal: "stop 之后不应被改写" },
    });
    assert.equal(res.status, 409);
    assert.equal((res.body as { error: { code: string } }).error.code, "task_terminated");
  } finally {
    await api.stop();
  }
});

test("stop moves to stopping, revokes the generation and refuses a late completion", async () => {
  const api = await boot();
  try {
    const created = await create(api, "stop-1");
    if ((created.status !== 201)) {
      throw new Error(`create failed: ${JSON.stringify(created)}`);
    }
    const taskId = (created.body as { taskId: string }).taskId;

    const stop = await httpJson(`${api.base}/api/tasks/${taskId}/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${api.token}` },
      body: { reason: "user_requested" },
    });
    if (stop.status !== 202) {
      throw new Error(`stop failed: ${JSON.stringify(stop)} (task now ${api.service.getTask(taskId).status})`);
    }
    assert.equal((stop.body as { status: string }).status, "stopping");
    assert.equal(api.service.getTask(taskId).status, "stopping");
    // The execution generation is revoked so nothing can write back.
    assert.equal(api.service.taskExecutionReachable(taskId), false);

    // A late completion callback for the stopped task must not revive it.
    const late = api.service.acceptCandidate(
      taskId,
      { inputDigest: api.service.getTask(taskId).inputDigest, verdict: "disconnected", incidents: [{ connectionId: "alpha", disconnectLine: 2, reconnectLine: null }] },
      "late-run",
    );
    assert.equal(late.status, "ignored_after_stop");
    assert.equal(api.service.getTask(taskId).status, "stopping");

    api.service.markStopped(taskId, { interrupted: true });
    assert.equal(api.service.getTask(taskId).status, "stopped");
    const events = api.service.ledger.forTask(taskId).map((event) => event.type);
    assert.deepEqual(events.filter((type) => type.startsWith("task_stop")), ["task_stopping", "task_stopped"]);
    assert.equal(events.includes("task_completed"), false);
  } finally {
    await api.stop();
  }
});

test("SSE replays history from afterSeq in order, without duplicates", async () => {
  const api = await boot();
  try {
    const first = await create(api, "sse-1");
    const firstId = (first.body as { taskId: string }).taskId;
    api.service.markWaiting(firstId, "t3_auth");
    await create(api, "sse-2");
    api.service.markWaiting(firstId, "t3_unavailable");

    // A full replay must match the ledger exactly: ordered and deduplicated.
    const all = api.service.ledger.afterSeq(0).map((event) => event.seq);
    assert.ok(all.length >= 4);
    const replayed = await readSseUntil(`${api.base}/api/events?afterSeq=0`, api.token, all.length);
    assert.deepEqual(
      replayed.map((event) => Number(event.seq)),
      all,
    );

    // Resuming from the pivot yields strictly the newer tail.
    const pivot = all[1]!;
    const resumed = await readSseUntil(`${api.base}/api/events?afterSeq=${pivot}`, api.token, all.length - 2);
    assert.deepEqual(
      resumed.map((event) => Number(event.seq)),
      all.slice(2),
    );
  } finally {
    await api.stop();
  }
});

test("SSE pushes events committed while the stream is open", async () => {
  const api = await boot();
  try {
    const created = await create(api, "sse-live");
    const taskId = (created.body as { taskId: string }).taskId;
    const baseline = api.service.ledger.latestSeq();

    // Open the stream first, then commit: the event must arrive without a new request.
    const received = readSseUntil(`${api.base}/api/events?afterSeq=${baseline}`, api.token, 1, 3_000);
    api.service.markWaiting(taskId, "t3_auth");
    const events = await received;
    assert.equal(events.length, 1);
    assert.equal(Number(events[0]!.seq), baseline + 1);
    assert.equal(events[0]!.type, "task_waiting");
  } finally {
    await api.stop();
  }
});

test("SSE reconnection from lastSeq delivers exactly the missed events", async () => {
  const api = await boot();
  try {
    const created = await create(api, "sse-gap");
    const taskId = (created.body as { taskId: string }).taskId;

    const firstBatch = await readSseUntil(`${api.base}/api/events?afterSeq=0`, api.token, 1);
    const lastSeq = Number(firstBatch[firstBatch.length - 1]!.seq);

    // Events produced while the client is disconnected.
    api.service.markWaiting(taskId, "t3_auth");
    api.service.markWaiting(taskId, "t3_unavailable");
    const expected = api.service.ledger.afterSeq(lastSeq).map((event) => event.seq);
    assert.equal(expected.length, 2);

    const resumed = await readSseUntil(`${api.base}/api/events?afterSeq=${lastSeq}`, api.token, expected.length);
    assert.deepEqual(
      resumed.map((event) => Number(event.seq)),
      expected,
    );
  } finally {
    await api.stop();
  }
});
