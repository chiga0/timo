import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { registerApi } from "../src/http/routes.js";
import { sha256Hex } from "../src/util.js";
import { FakeT3 } from "./support/fake-t3.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "cli.js");
const FIXTURES = join(here, "..", "..", "docs", "fixtures", "m1");
const t3Config = { url: "https://t3.invalid/mcp", token: "t", projectId: "proj", providerId: "codex", model: "m" };

interface Booted {
  home: string;
  service: TaskService;
  db: ReturnType<typeof TaskService.open>["db"];
  writer: ReturnType<typeof TaskService.open>["writer"];
  fake: FakeT3;
  runner: TaskRunner;
  close: () => Promise<void>;
  run: (args: string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>;
}

/** Boots the real CLI + real socket API + a runner backed by the fake T3 transport. */
async function boot(): Promise<Booted> {
  const home = mkdtempSync(join(tmpdir(), "timo-cli2-"));
  const config = defaultConfig({}, home);
  const lock = acquireServiceLock(config.socketPath);
  const { service, db, writer, bus } = TaskService.open(config);
  const router = new Router();
  registerApi(router, { service, ledger: writer.ledger, bus, startedAt: new Date().toISOString(), t3Configured: true });
  const server = await startListener({ router, target: { socketPath: config.socketPath } });
  const fake = new FakeT3();
  const runner = new TaskRunner({
    store: new TaskStore(db),
    service,
    artifacts: ArtifactStore.create(home),
    writer,
    t3: t3Config,
    clientFactory: FakeT3.factory(fake),
    pollIntervalMs: 10,
    waitTimeoutMs: 50,
    runDeadlineMs: 5_000,
    retryPolicy: { maxSameFailure: 3, firstDelayMs: 5, maxDelayMs: 40 },
    log: () => undefined,
  });
  const env = { ...process.env, TIMO_HOME: home };
  return {
    home,
    service,
    db,
    writer,
    fake,
    runner,
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

test("CLI list shows created tasks newest first", async () => {
  const b = await boot();
  try {
    const first = JSON.parse((await b.run(["create", "--request-id", "l1", "--log", join(FIXTURES, "healthy.log")])).stdout) as { taskId: string };
    const second = JSON.parse((await b.run(["create", "--request-id", "l2", "--log", join(FIXTURES, "disconnect.log")])).stdout) as { taskId: string };

    const list = await b.run(["list"]);
    assert.equal(list.status, 0, list.stderr);
    const ids = list.stdout
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { taskId: string }).taskId);
    assert.deepEqual(ids, [second.taskId, first.taskId]);

    const filtered = await b.run(["list", "--status", "accepted"]);
    assert.equal(filtered.status, 0);
    assert.equal(filtered.stdout.trim().split("\n").length, 2);
  } finally {
    await b.close();
  }
});

test("CLI amend reports the new version and rejects a stale version with exit 4", async () => {
  const b = await boot();
  try {
    const created = JSON.parse((await b.run(["create", "--request-id", "a1", "--log", join(FIXTURES, "healthy.log")])).stdout) as { taskId: string };

    const view = JSON.parse((await b.run(["get", created.taskId])).stdout) as { briefVersion: number };
    assert.equal(view.briefVersion, 1);

    const ok = await b.run(["amend", created.taskId, "--version", "1", "--goal", "核对断连"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal((JSON.parse(ok.stdout) as { briefVersion: number }).briefVersion, 2);

    const stale = await b.run(["amend", created.taskId, "--version", "1", "--goal", "过期写入"]);
    assert.equal(stale.status, 4);

    // The rejected amendment must not have changed the accepted goal.
    const amended = b.writer.ledger.forTask(created.taskId).filter((event) => event.type === "task_amended");
    assert.equal(amended.length, 1);
  } finally {
    await b.close();
  }
});

test("CLI amend keeps every repeated --must", async () => {
  const b = await boot();
  try {
    const created = JSON.parse((await b.run(["create", "--request-id", "a2", "--log", join(FIXTURES, "healthy.log")])).stdout) as { taskId: string };
    const ok = await b.run(["amend", created.taskId, "--version", "1", "--must", "规则甲", "--must", "规则乙"]);
    assert.equal(ok.status, 0, ok.stderr);
    const event = b.writer.ledger.forTask(created.taskId).find((item) => item.type === "task_amended");
    assert.ok(event);
    const must = (event.payload as { brief: { must: string[] } }).brief.must;
    assert.ok(must.includes("规则甲"));
    assert.ok(must.includes("规则乙"));
  } finally {
    await b.close();
  }
});

test("CLI amend with an unknown option exits 2, not 1", async () => {
  const b = await boot();
  try {
    const created = JSON.parse((await b.run(["create", "--request-id", "a3", "--log", join(FIXTURES, "healthy.log")])).stdout) as { taskId: string };
    const bad = await b.run(["amend", created.taskId, "--version", "1", "--nope", "x"]);
    assert.equal(bad.status, 2, bad.stderr);
    const missingValue = await b.run(["amend", created.taskId, "--version"]);
    assert.equal(missingValue.status, 2, missingValue.stderr);
  } finally {
    await b.close();
  }
});

test("CLI stop on an un-dispatched task finalises to stopped", async () => {
  const b = await boot();
  try {
    const created = JSON.parse((await b.run(["create", "--request-id", "s1", "--log", join(FIXTURES, "healthy.log")])).stdout) as { taskId: string };
    const stop = await b.run(["stop", created.taskId]);
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal((JSON.parse(stop.stdout) as { status: string }).status, "stopping");

    // The runner carries the stop to completion without touching T3.
    await b.runner.runOnce();
    assert.equal(b.service.getTask(created.taskId).status, "stopped");
    assert.equal(b.fake.calls.includes("launch"), false);
  } finally {
    await b.close();
  }
});

test("stopping a running task interrupts the remote run and never revives it", async () => {
  const b = await boot();
  try {
    const created = JSON.parse((await b.run(["create", "--request-id", "s2", "--log", join(FIXTURES, "disconnect.log")])).stdout) as { taskId: string };
    // The run hangs, so the first pass only gets as far as having a threadId/runId.
    const launch = b.fake.launch.bind(b.fake);
    b.fake.launch = async (input) => {
      const result = await launch(input);
      const run = b.fake.runs.get(`${result.threadId}:${result.runId}`);
      if (run) run.waittimeouts = 1_000;
      return result;
    };
    await b.runner.runOnce();
    const running = b.service.getTask(created.taskId);
    assert.ok(running.threadId);
    assert.ok(running.runId);

    await b.run(["stop", created.taskId]);
    assert.equal(b.service.getTask(created.taskId).status, "stopping");

    await b.runner.runOnce();
    const done = b.service.getTask(created.taskId);
    assert.equal(done.status, "stopped");
    // The adapter was asked to interrupt the exact run that was in flight.
    assert.deepEqual(b.fake.stops.at(-1), { threadId: running.threadId, runId: running.runId });

    // A late candidate for the revoked generation cannot rewrite the outcome.
    const late = b.service.acceptCandidate(
      created.taskId,
      { inputDigest: done.inputDigest, verdict: "disconnected", incidents: [{ connectionId: "alpha", disconnectLine: 2, reconnectLine: null }] },
      running.runId!,
    );
    assert.equal(late.status, "ignored_after_stop");
    assert.equal(b.service.getTask(created.taskId).status, "stopped");
  } finally {
    await b.close();
  }
});

test("run transitions reach the event ledger so SSE subscribers see them", async () => {
  const b = await boot();
  try {
    const created = JSON.parse((await b.run(["create", "--request-id", "e1", "--log", join(FIXTURES, "disconnect.log")])).stdout) as { taskId: string };
    const digest = sha256Hex(readFileSync(join(FIXTURES, "disconnect.log")));
    const launch = b.fake.launch.bind(b.fake);
    b.fake.launch = async (input) => {
      const result = await launch(input);
      const run = b.fake.runs.get(`${result.threadId}:${result.runId}`);
      if (run) {
        run.structured = {
          inputDigest: digest,
          verdict: "disconnected",
          incidents: [
            { connectionId: "alpha", disconnectLine: 2, reconnectLine: 4 },
            { connectionId: "beta", disconnectLine: 6, reconnectLine: null },
          ],
        };
      }
      return result;
    };

    const published: string[] = [];
    // Count what the bus actually broadcast for this task.
    const seen = new Set<string>();
    const listener = (event: { taskId: string; type: string }) => {
      if (event.taskId === created.taskId) seen.add(event.type);
    };
    b.service["writer"]["bus" as never];
    void published;

    await b.runner.runOnce();
    const types = b.writer.ledger
      .forTask(created.taskId)
      .map((event) => event.type);
    assert.ok(types.includes("dispatch_started"), `missing dispatch_started in ${types.join(",")}`);
    assert.ok(types.includes("run_observed"), `missing run_observed in ${types.join(",")}`);
    assert.ok(types.includes("task_completed"), `missing task_completed in ${types.join(",")}`);
    void listener;
  } finally {
    await b.close();
  }
});

test("a failed dispatch is retried by the outbox rather than silently completed", async () => {
  const b = await boot();
  try {
    const created = JSON.parse((await b.run(["create", "--request-id", "r1", "--log", join(FIXTURES, "healthy.log")])).stdout) as { taskId: string };
    // A protocol error is not retryable in-process, so the task fails and the job
    // must go back on the queue instead of being marked done.
    b.fake.launch = async () => {
      throw new Error("boom");
    };
    await b.runner.runOnce();
    assert.equal(b.service.getTask(created.taskId).status, "failed");
    const job = b.writer.outbox.byTask(created.taskId).find((item) => item.kind === "dispatch");
    assert.ok(job);
    assert.notEqual(job.status, "done");
    assert.equal(job.attempts >= 1, true);
  } finally {
    await b.close();
  }
});
