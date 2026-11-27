import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskService } from "../src/service/task-service.js";
import { TaskRunner } from "../src/service/runner.js";
import { TaskStore } from "../src/store/tasks.js";
import { ArtifactStore } from "../src/store/artifacts.js";
import { defaultConfig } from "../src/config.js";
import { acquireServiceLock } from "../src/ipc.js";
import { Router, startListener } from "../src/http/server.js";
import { registerApi, type ApiDeps } from "../src/http/routes.js";
import type { EventLedger } from "../src/events/ledger.js";
import { sha256Hex } from "../src/util.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import {
  ExecutorRegistry,
  ExecutorUnavailableError,
  type ExecutionAdapter,
  type ExecutorDescriptor,
} from "../src/adapters/execution.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "cli.js");
const FIXTURES = join(here, "..", "..", "docs", "fixtures", "m1");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
};

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

function makeRepo(root: string, name: string): string {
  const dir = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: GIT_ENV });
  writeFileSync(join(dir, "app.mjs"), "export const fixed = false;\n");
  git(["add", "."], dir);
  git(["commit", "-qm", "init"], dir);
  return dir;
}

/** Probe-only executor stub; a handoff never spawns the new runtime itself. */
class ProbeOnlyAdapter implements ExecutionAdapter {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  async probe(): Promise<ExecutorDescriptor> {
    return { id: this.id, kind: "cli", available: true, capabilities: { steer: false, stream: true } };
  }
  async spawn(): Promise<never> {
    throw new Error("handoff must not spawn the target executor");
  }
  async resume(): Promise<never> {
    throw new Error("not supported");
  }
  async steer(): Promise<{ accepted: boolean; reason?: string }> {
    return { accepted: false, reason: "probe only" };
  }
  async interrupt(): Promise<{ interrupted: boolean }> {
    return { interrupted: false };
  }
}

/**
 * Mirrors the `timo serve` wiring for `/api/tasks/:id/handoff`: the requested
 * executor must be registered, then the generation advances immutably.
 */
function handoffApiDeps(options: {
  service: TaskService;
  store: TaskStore;
  executors: ExecutorRegistry;
  workspaces: WorkspaceManager;
  gateway?: { revoke(taskId: string, generation?: number): void };
  interruptActive?: (taskId: string) => Promise<void>;
}): Required<Pick<ApiDeps, "handoff">> {
  const { executors } = options;
  return {
    handoff: (taskId, input) => {
      executors.require(input.executorId);
      return options.service.handoffTask(taskId, {
        toExecutor: input.executorId,
        model: input.model,
        reason: input.reason,
        workspaces: options.workspaces,
        ...(options.gateway ? { mcpGateway: options.gateway } : {}),
        ...(options.interruptActive ? { interruptActive: options.interruptActive } : {}),
      });
    },
  };
}

type ApiHandoffDeps = Pick<ApiDeps, "executors">;

interface Booted {
  home: string;
  close: () => Promise<void>;
  service: TaskService;
  store: TaskStore;
  workspaces: WorkspaceManager;
  executors: ExecutorRegistry;
  ledger: EventLedger;
  run: (args: string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>;
}

/**
 * Boots the real socket server with the real CLI in the same TIMO_HOME. The CLI
 * runs as a child process; the parent awaits it without blocking the server's
 * event loop, which is what a user's shell would look like. Passing `apiDeps`
 * wires the same `/api/tasks/:id/handoff` hook `timo serve` installs.
 */
async function boot(
  options: { apiDeps?: ApiHandoffDeps; gateway?: unknown; interruptActive?: (taskId: string) => Promise<void> } = {},
): Promise<Booted> {
  const home = mkdtempSync(join(tmpdir(), "timo-cli-"));
  const config = defaultConfig({}, home);
  const lock = acquireServiceLock(config.socketPath);
  const { service, db, writer, bus } = TaskService.open(config);
  const ledger = writer.ledger;
  const store = new TaskStore(db);
  const workspaces = new WorkspaceManager({ home: join(home, "workspaces") });
  const executors = options.apiDeps?.executors ?? new ExecutorRegistry();
  const router = new Router();
  registerApi(router, {
    service,
    ledger: writer.ledger,
    bus,
    startedAt: new Date().toISOString(),
    t3Configured: false,
    ...(options.apiDeps
      ? {
          executors,
          ...handoffApiDeps({
            service,
            store,
            executors,
            workspaces,
            ...(options.gateway ? { gateway: options.gateway as { revoke(taskId: string, generation?: number): void } } : {}),
            ...(options.interruptActive ? { interruptActive: options.interruptActive } : {}),
          }),
        }
      : {}),
  });
  const server = await startListener({ router, target: { socketPath: config.socketPath } });
  const env = { ...process.env, TIMO_HOME: home };
  return {
    home,
    service,
    store,
    workspaces,
    executors,
    ledger,
    close: async () => {
      await server.close();
      service.close();
      lock.release();
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
  const { service, db, writer } = TaskService.open(config);
  const artifacts = ArtifactStore.create(home);
  const runner = new TaskRunner({
    store: new TaskStore(db),
    service,
    artifacts,
    writer,
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

/** Probed registry holding the given ready executors (handoff needs them registered). */
async function readyExecutors(ids: string[]): Promise<ExecutorRegistry> {
  const executors = new ExecutorRegistry();
  for (const id of ids) executors.register(new ProbeOnlyAdapter(id));
  await executors.probeAll();
  return executors;
}

test("timo handoff posts executorId/reason and moves the task to an immutable g2 generation", async () => {
  const revoked: Array<{ taskId: string; generation?: number }> = [];
  const interrupted: string[] = [];
  const booted = await boot({
    apiDeps: { executors: await readyExecutors(["qwen-code", "pi"]) },
    gateway: { revoke: (taskId: string, generation?: number) => revoked.push({ taskId, generation }) },
    interruptActive: async (taskId: string) => {
      interrupted.push(taskId);
    },
  });
  const workspaces = booted.workspaces;
  try {
    const repoPath = makeRepo(booted.home, "repo-cli-handoff");
    const created = booted.service.createTask({
      requestId: "cli-handoff-1",
      kind: "repo_delivery",
      requestText: "Fix app.mjs",
      executorId: "qwen-code",
      repos: [{ sourcePath: repoPath, baseRef: "main", name: "repo" }],
    });
    const g1 = workspaces.prepare(created.taskId, [{ sourcePath: repoPath, baseRef: "main", name: "repo" }], 1);
    const g1Dir = g1.repos[0]!.worktreePath;
    booted.service.updateRepoStates(created.taskId, [
      {
        name: "repo",
        sourcePath: repoPath,
        baseRef: "main",
        baseSha: g1.repos[0]!.baseSha,
        headSha: g1.repos[0]!.baseSha,
        worktreePath: g1Dir,
        branch: g1.repos[0]!.branch,
      },
    ]);
    writeFileSync(join(g1Dir, "app.mjs"), "// g1 wip\nexport const fixed = true;\n");

    const handed = await booted.run(["handoff", created.taskId, "--executor", "pi", "--reason", "pi 路由更稳"]);
    assert.equal(handed.status, 0, handed.stderr);
    const body = JSON.parse(handed.stdout) as {
      taskId: string;
      fromGeneration: number;
      toGeneration: number;
      fromExecutor: string;
      toExecutor: string;
      capsule: { toExecutor: string; reason?: string };
    };
    assert.equal(body.taskId, created.taskId);
    assert.equal(body.fromGeneration, 1);
    assert.equal(body.toGeneration, 2);
    assert.equal(body.fromExecutor, "qwen-code");
    assert.equal(body.toExecutor, "pi");
    assert.equal(body.capsule.toExecutor, "pi");
    // The operator reason reaches the service: it is recorded on the handoff event.
    const handedOff = booted.ledger
      .forTask(created.taskId, 0, 500)
      .find((event) => (event.payload as { handoff?: { reason?: string } } | null)?.handoff !== undefined);
    assert.equal((handedOff?.payload as { handoff: { reason: string } }).handoff.reason, "pi 路由更稳");

    const view = booted.service.getTask(created.taskId);
    assert.equal(view.executorId, "pi");
    const g2Dir = view.repos![0]!.worktreePath!;
    assert.equal(g2Dir, workspaces.load(created.taskId, 2)!.repos[0]!.worktreePath);
    assert.notEqual(g2Dir, g1Dir);
    assert.equal(readFileSync(join(g2Dir, "app.mjs"), "utf8"), "// g1 wip\nexport const fixed = true;\n");
    assert.equal(readFileSync(join(g1Dir, "app.mjs"), "utf8"), "// g1 wip\nexport const fixed = true;\n", "g1 is frozen, not moved");
    // The old generation is fenced before migrating: token revoked, live run interrupted.
    assert.deepEqual(revoked, [{ taskId: created.taskId, generation: 1 }]);
    assert.deepEqual(interrupted, [created.taskId]);
  } finally {
    await booted.close();
  }
});

test("timo handoff surfaces usage, unavailable executor and unknown task errors", async () => {
  const booted = await boot({ apiDeps: { executors: await readyExecutors(["qwen-code"]) } });
  try {
    const created = booted.service.createTask({ requestId: "cli-handoff-2", log: new Uint8Array(readFileSync(join(FIXTURES, "healthy.log"))) });

    const missingExecutor = await booted.run(["handoff", created.taskId]);
    assert.equal(missingExecutor.status, 2);
    assert.match(missingExecutor.stderr, /--executor/);

    const missingTaskId = await booted.run(["handoff", "--executor", "qwen-code"]);
    assert.equal(missingTaskId.status, 2);
    assert.match(missingTaskId.stderr, /TASK_ID/);

    const unknownExecutor = await booted.run(["handoff", created.taskId, "--executor", "nope"]);
    assert.equal(unknownExecutor.status, 1);
    assert.match(unknownExecutor.stderr, /executor nope is unavailable: not registered/);

    const unknownTask = await booted.run(["handoff", "00000000-0000-4000-8000-000000000000", "--executor", "qwen-code"]);
    assert.equal(unknownTask.status, 3);
  } finally {
    await booted.close();
    rmSync(booted.home, { recursive: true, force: true });
  }
});

test("timo handoff returns 501 when the service does not wire the handoff route", async () => {
  const booted = await boot();
  try {
    const created = booted.service.createTask({ requestId: "cli-handoff-3", log: new Uint8Array(readFileSync(join(FIXTURES, "healthy.log"))) });
    const unsupported = await booted.run(["handoff", created.taskId, "--executor", "qwen-code"]);
    assert.equal(unsupported.status, 2);
    assert.match(unsupported.stderr, /executor handoff is not configured/);
  } finally {
    await booted.close();
    rmSync(booted.home, { recursive: true, force: true });
  }
});

test("timo help lists the handoff command", async () => {
  const booted = await boot();
  try {
    const help = await booted.run(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /timo handoff TASK_ID --executor ID \[--reason TEXT\]/);
  } finally {
    await booted.close();
    rmSync(booted.home, { recursive: true, force: true });
  }
});

test("POST /api/tasks/:id/handoff validates the body and forwards to the handoff hook", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-cli-"));
  const config = defaultConfig({}, home);
  const { service, writer, bus } = TaskService.open(config);
  const calls: Array<{ taskId: string; input: { executorId: string; model?: string; reason?: string } }> = [];
  const router = new Router();
  registerApi(router, {
    service,
    ledger: writer.ledger,
    bus,
    startedAt: new Date().toISOString(),
    t3Configured: false,
    handoff: async (taskId, input) => {
      calls.push({ taskId, input });
      return { taskId, fromGeneration: 1, toGeneration: 2, toExecutor: input.executorId };
    },
  });
  try {
    const created = service.createTask({ requestId: "cli-handoff-4", log: new Uint8Array(readFileSync(join(FIXTURES, "healthy.log"))) });
    const respond = async (body: unknown) => {
      const path = `/api/tasks/${created.taskId}/handoff`;
      const context = { method: "POST", path, query: new URLSearchParams(), params: {}, body, accept: "application/json", trustedLocal: true };
      const matched = await router.dispatch(context);
      assert.ok(matched, "handoff route must be registered");
      return await matched.route.handler({ ...context, params: matched.params });
    };

    await assert.rejects(
      async () => respond({ reason: "no executor" }),
      (error: { status?: number; code?: string }) => error.status === 400 && error.code === "invalid_input",
    );
    assert.equal(calls.length, 0);

    const ok = await respond({ executorId: "pi", reason: "手动切换", model: "m1" });
    assert.equal((ok.body as { toGeneration: number }).toGeneration, 2);
    assert.deepEqual(calls, [{ taskId: created.taskId, input: { executorId: "pi", model: "m1", reason: "手动切换" } }]);
  } finally {
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
});
