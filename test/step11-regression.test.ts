import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/service/task-service.js";
import { TaskRunner } from "../src/service/runner.js";
import { TaskStore } from "../src/store/tasks.js";
import { ArtifactStore } from "../src/store/artifacts.js";
import { defaultConfig } from "../src/config.js";
import { T3Error } from "../src/adapters/t3.js";
import { sha256Hex } from "../src/util.js";
import { FakeT3 } from "./support/fake-t3.js";

const encoder = new TextEncoder();
const disconnect = encoder.encode(
  "2026-11-26T00:00:01Z alpha CONNECT\n2026-11-26T00:00:02Z alpha DISCONNECT\n2026-11-26T00:00:04Z alpha RECONNECT\n",
);
const digestOf = sha256Hex(disconnect);
const t3Config = { url: "https://t3.invalid/mcp", token: "test-token", projectId: "proj", providerId: "codex", model: "fake-model" };
const candidate = {
  inputDigest: digestOf,
  verdict: "disconnected",
  incidents: [{ connectionId: "alpha", disconnectLine: 2, reconnectLine: 3 }],
};

function harness(concurrency = 4) {
  const home = mkdtempSync(join(tmpdir(), "timo-concurrency-"));
  const config = defaultConfig({}, home);
  const { service, db } = TaskService.open(config);
  const fake = new FakeT3();
  const runner = new TaskRunner({
    store: new TaskStore(db),
    service,
    artifacts: ArtifactStore.create(home),
    t3: t3Config,
    clientFactory: FakeT3.factory(fake),
    pollIntervalMs: 10,
    waitTimeoutMs: 50,
    runDeadlineMs: 5_000,
    concurrency,
    retryPolicy: { maxSameFailure: 3, firstDelayMs: 5, maxDelayMs: 40 },
    log: () => undefined,
  });
  return {
    home,
    service,
    db,
    fake,
    runner,
    dispose: () => {
      service.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("a slow task does not block a fast one in the same pass", async () => {
  const h = harness();
  try {
    const launch = h.fake.launch.bind(h.fake);
    h.fake.launch = async (input) => {
      const result = await launch(input);
      const run = h.fake.runs.get(`${result.threadId}:${result.runId}`);
      if (!run) return result;
      run.structured = candidate;
      // The first task takes ~600ms; the second returns immediately.
      run.delayMs = h.fake.runs.size === 1 ? 600 : 0;
      return result;
    };
    const slow = h.service.createTask({ requestId: "slow", log: disconnect });
    const fast = h.service.createTask({ requestId: "fast", log: disconnect });

    const started = Date.now();
    await h.runner.runOnce();
    const elapsed = Date.now() - started;

    assert.equal(h.service.getTask(slow.taskId).status, "completed");
    assert.equal(h.service.getTask(fast.taskId).status, "completed");
    // Serial execution would take ~600ms; the fast task must finish alongside.
    assert.ok(elapsed < 1100, `pass took ${elapsed}ms`);
  } finally {
    h.dispose();
  }
});

test("a completed remote run is reconciled after a restart and the task completes", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-reconcile-"));
  const config = defaultConfig({}, home);
  const fake = new FakeT3();
  const launch = fake.launch.bind(fake);
  fake.launch = async (input) => {
    const result = await launch(input);
    const run = fake.runs.get(`${result.threadId}:${result.runId}`);
    if (run) run.structured = candidate;
    return result;
  };
  try {
    // First process: dispatch happens but the run does not finish before the kill.
    const first = TaskService.open(config);
    const firstRunner = new TaskRunner({
      store: new TaskStore(first.db),
      service: first.service,
      artifacts: ArtifactStore.create(home),
      t3: t3Config,
      clientFactory: FakeT3.factory(fake),
      pollIntervalMs: 10,
      waitTimeoutMs: 5,
      runDeadlineMs: 1,
      retryPolicy: { maxSameFailure: 3, firstDelayMs: 5, maxDelayMs: 20 },
      log: () => undefined,
    });
    // The run stays "running" for the first process.
    fake.launch = async (input) => {
      const result = await launch(input);
      const run = fake.runs.get(`${result.threadId}:${result.runId}`);
      if (run) {
        run.structured = candidate;
        run.waittimeouts = 1_000;
      }
      return result;
    };
    const created = first.service.createTask({ requestId: "recon", log: disconnect });
    await firstRunner.runOnce();
    const afterKillLike = first.service.getTask(created.taskId);
    assert.equal(afterKillLike.threadId !== null, true);
    assert.equal(afterKillLike.runId !== null, true);
    first.service.close(); // stands in for the process dying

    // The remote run has since finished; a new process only reconciles.
    const run = fake.runs.get(`${afterKillLike.threadId}:${afterKillLike.runId}`);
    assert.ok(run);
    run.waittimeouts = 0;

    const second = TaskService.open(config);
    const callCount = { launch: 0 };
    fake.launch = async () => {
      callCount.launch++;
      throw new T3Error("protocol", "reconcile must not launch a new thread");
    };
    const secondRunner = new TaskRunner({
      store: new TaskStore(second.db),
      service: second.service,
      artifacts: ArtifactStore.create(home),
      t3: t3Config,
      clientFactory: FakeT3.factory(fake),
      pollIntervalMs: 10,
      waitTimeoutMs: 50,
      runDeadlineMs: 5_000,
      retryPolicy: { maxSameFailure: 3, firstDelayMs: 5, maxDelayMs: 20 },
      log: () => undefined,
    });
    await secondRunner.runOnce();
    const view = second.service.getTask(created.taskId);
    second.service.close();

    assert.equal(callCount.launch, 0);
    assert.equal(view.status, "completed");
    assert.deepEqual(view.result, { ...candidate, verifierVersion: "sse-v1" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the same waiting reason twice produces two undelivered notifications", async () => {
  const h = harness();
  try {
    h.fake.failAll = new T3Error("auth", "HTTP 401");
    const created = h.service.createTask({ requestId: "notify", log: disconnect });
    await h.runner.runOnce();
    // Clear the backoff so the second attempt runs immediately.
    const store = new TaskStore(h.db);
    store.setEvidence(created.taskId, "dispatchNotBefore", new Date(0).toISOString(), new Date().toISOString());
    h.db.prepare("UPDATE operations SET status = 'pending' WHERE task_id = ?").run(created.taskId);

    await h.runner.runOnce();
    const waiting = store.undeliveredNotifications(created.taskId).filter((item) => item.kind === "waiting_t3_auth");
    assert.equal(waiting.length, 2);
  } finally {
    h.dispose();
  }
});

test("a bound execution records the provider and model actually used", async () => {
  const h = harness();
  try {
    const launch = h.fake.launch.bind(h.fake);
    h.fake.launch = async (input) => {
      const result = await launch(input);
      const run = h.fake.runs.get(`${result.threadId}:${result.runId}`);
      if (run) run.structured = candidate;
      return result;
    };
    const created = h.service.createTask({ requestId: "bind", log: disconnect });
    await h.runner.runOnce();
    const row = h.db
      .prepare("SELECT provider_instance_id, model FROM executions WHERE task_id = ?")
      .get(created.taskId) as { provider_instance_id: string; model: string };
    assert.equal(row.provider_instance_id, "codex");
    assert.equal(row.model, "fake-model");
  } finally {
    h.dispose();
  }
});
