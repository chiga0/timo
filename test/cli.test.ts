import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskService, TaskNotFoundError } from "../src/service/task-service.js";
import { RequestConflictError } from "../src/store/tasks.js";
import { TaskRunner } from "../src/service/runner.js";
import { TaskStore } from "../src/store/tasks.js";
import { ArtifactStore } from "../src/store/artifacts.js";
import { defaultConfig } from "../src/config.js";
import { startServiceServer, type WireRequest, type WireResponse } from "../src/ipc.js";
import { sha256Hex } from "../src/util.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "cli.js");
const FIXTURES = join(here, "..", "..", "docs", "fixtures", "m1");

interface Booted {
  home: string;
  close: () => Promise<void>;
  service: TaskService;
  run: (args: string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>;
}

/**
 * Boots the real socket server with the real CLI in the same TIMO_HOME. The CLI
 * runs as a child process; the parent awaits it without blocking the server's
 * event loop, which is what a user's shell would look like.
 */
async function boot(): Promise<Booted> {
  const home = mkdtempSync(join(tmpdir(), "timo-cli-"));
  const config = defaultConfig({}, home);
  const { service } = TaskService.open(config);
  const server = await startServiceServer(config, async (request: WireRequest): Promise<WireResponse> => {
    try {
      return { id: request.id, ok: true, result: dispatch(request) };
    } catch (error) {
      const code =
        error instanceof TaskNotFoundError
          ? "not_found"
          : error instanceof RequestConflictError
            ? "request_conflict"
            : "invalid_input";
      return { id: request.id, ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } };
    }
  });
  function dispatch(request: WireRequest): unknown {
    if (request.command === "create") {
      const bytes = Uint8Array.from(Buffer.from(String(request.params.log), "base64"));
      const created = service.createTask({ requestId: String(request.params.requestId), log: bytes });
      return { taskId: created.taskId, status: created.status };
    }
    return service.getTask(String(request.params.taskId));
  }
  const env = { ...process.env, TIMO_HOME: home };
  return {
    home,
    service,
    close: async () => {
      await server.close();
      service.close();
      rmSync(home, { recursive: true, force: true });
    },
    run: (args) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI, ...args], { env });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (stdout += chunk));
        child.stderr.on("data", (chunk: string) => (stderr += chunk));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      }),
  };
}

test("CLI create and get round-trip through the socket", async () => {
  const booted = await boot();
  try {
    const created = await booted.run(["create", "--request-id", "cli-1", "--log", join(FIXTURES, "disconnect.log")]);
    assert.equal(created.status, 0, created.stderr);
    const body = JSON.parse(created.stdout) as { taskId: string; status: string };
    assert.match(body.taskId, /^[0-9a-f-]{36}$/);
    assert.equal(body.status, "accepted");

    const fetched = await booted.run(["get", body.taskId]);
    assert.equal(fetched.status, 0, fetched.stderr);
    const view = JSON.parse(fetched.stdout) as Record<string, unknown>;
    assert.equal(view.taskId, body.taskId);
    assert.equal(view.inputDigest, sha256Hex(readFileSync(join(FIXTURES, "disconnect.log"))));
    assert.equal(view.threadId, null);
    assert.equal(view.status, "accepted");
  } finally {
    await booted.close();
  }
});

test("CLI reuses the original task for the same request id and bytes", async () => {
  const booted = await boot();
  try {
    const log = join(FIXTURES, "healthy.log");
    const first = JSON.parse((await booted.run(["create", "--request-id", "cli-2", "--log", log])).stdout) as { taskId: string };
    const second = await booted.run(["create", "--request-id", "cli-2", "--log", log]);
    assert.equal(second.status, 0);
    assert.equal((JSON.parse(second.stdout) as { taskId: string }).taskId, first.taskId);
  } finally {
    await booted.close();
  }
});

test("CLI rejects reused request id with different content as a conflict", async () => {
  const booted = await boot();
  try {
    await booted.run(["create", "--request-id", "cli-3", "--log", join(FIXTURES, "healthy.log")]);
    const conflict = await booted.run(["create", "--request-id", "cli-3", "--log", join(FIXTURES, "disconnect.log")]);
    assert.equal(conflict.status, 4);
    assert.match(conflict.stderr, /请求冲突|conflict|different content/i);
  } finally {
    await booted.close();
  }
});

test("CLI reports an unknown task with exit code 3", async () => {
  const booted = await boot();
  try {
    const missing = await booted.run(["get", "00000000-0000-4000-8000-000000000000"]);
    assert.equal(missing.status, 3);
  } finally {
    await booted.close();
  }
});

test("CLI rejects a missing log file with exit code 2", async () => {
  const booted = await boot();
  try {
    const invalid = await booted.run(["create", "--request-id", "cli-4", "--log", "/does/not/exist.log"]);
    assert.equal(invalid.status, 2);
  } finally {
    await booted.close();
  }
});

test("a task survives while T3 is unreachable and keeps its pending dispatch", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-cli-"));
  const config = defaultConfig({}, home);
  const { service, db } = TaskService.open(config);
  const artifacts = ArtifactStore.create(home);
  const runner = new TaskRunner({
    store: new TaskStore(db),
    service,
    artifacts,
    t3: { url: "https://t3.invalid/mcp", token: "x", projectId: "p", providerId: "c", model: "m" },
    clientFactory: () => {
      throw new Error("connect ECONNREFUSED");
    },
    pollIntervalMs: 5,
    waitTimeoutMs: 10,
    runDeadlineMs: 50,
    retryPolicy: { maxSameFailure: 3, firstDelayMs: 5, maxDelayMs: 20 },
    log: () => undefined,
  });
  try {
    const created = service.createTask({ requestId: "cli-6", log: new Uint8Array(readFileSync(join(FIXTURES, "disconnect.log"))) });
    await runner.runOnce();
    const view = service.getTask(created.taskId);
    assert.equal(view.status, "waiting");
    assert.equal(view.waitingReason, "t3_unavailable");
    assert.equal(view.threadId, null);
  } finally {
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
});
