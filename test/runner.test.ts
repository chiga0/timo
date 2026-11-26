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
  "2026-11-26T00:00:01Z alpha CONNECT\n2026-11-26T00:00:02Z alpha DISCONNECT\n2026-11-26T00:00:03Z beta CONNECT\n2026-11-26T00:00:04Z alpha RECONNECT\n2026-11-26T00:00:05Z alpha HEARTBEAT\n2026-11-26T00:00:06Z beta DISCONNECT\n",
);
const healthy = encoder.encode("2026-11-26T00:00:01Z alpha CONNECT\n2026-11-26T00:00:02Z alpha HEARTBEAT\n");
const digestOf = sha256Hex(disconnect);

const t3Config = { url: "https://t3.invalid/mcp", token: "test-token", projectId: "proj", providerId: "codex", model: "fake-model" };

interface Harness {
  home: string;
  service: TaskService;
  runner: TaskRunner;
  fake: FakeT3;
  logs: string[];
  dispose: () => void;
}

/**
 * Makes every submitted run answer with `candidate` (structured output) while
 * keeping the fake's own run bookkeeping intact.
 */
function withCandidates(h: Harness, candidate: unknown): void {
  const launch = h.fake.launch.bind(h.fake);
  h.fake.launch = async (input) => {
    const result = await launch(input);
    const run = h.fake.runs.get(`${result.threadId}:${result.runId}`);
    if (run) run.structured = candidate;
    return result;
  };
}

function harness(options: { t3?: boolean } = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), "timo-runner-"));
  const config = defaultConfig({}, home);
  const { service, db } = TaskService.open(config);
  const fake = new FakeT3();
  const logs: string[] = [];
  const runner = new TaskRunner({
    store: new TaskStore(db),
    service,
    artifacts: ArtifactStore.create(home),
    t3: options.t3 === false ? null : t3Config,
    clientFactory: FakeT3.factory(fake),
    pollIntervalMs: 10,
    waitTimeoutMs: 50,
    runDeadlineMs: 5_000,
    retryPolicy: { maxSameFailure: 3, firstDelayMs: 5, maxDelayMs: 40 },
    log: (line) => logs.push(line),
  });
  return {
    home,
    service,
    runner,
    fake,
    logs,
    dispose: () => {
      service.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("dispatched run with a correct candidate completes with a sealed result", async () => {
  const h = harness();
  try {
    const candidate = {
      inputDigest: digestOf,
      verdict: "disconnected",
      incidents: [
        { connectionId: "alpha", disconnectLine: 2, reconnectLine: 4 },
        { connectionId: "beta", disconnectLine: 6, reconnectLine: null },
      ],
    };
    withCandidates(h, candidate);
    const created = h.service.createTask({ requestId: "r1", log: disconnect });
    await h.runner.runOnce();
    const view = h.service.getTask(created.taskId);
    assert.equal(view.status, "completed");
    assert.equal(view.threadId, "thread-1");
    assert.equal(view.runId, "run-1");
    assert.deepEqual(view.result, {
      verdict: "disconnected",
      incidents: [
        { connectionId: "alpha", disconnectLine: 2, reconnectLine: 4 },
        { connectionId: "beta", disconnectLine: 6, reconnectLine: null },
      ],
      inputDigest: digestOf,
      verifierVersion: "sse-v1",
    });
    // v0.1.12 order: launch (thread + first prompt + schema) -> wait.
    // The structured candidate arrives through the wait result, so no read is needed.
    assert.deepEqual(h.fake.calls.slice(0, 2), ["launch", "wait"]);
    assert.equal(h.fake.submissions[0]?.clientRequestId, `${created.taskId}:launch`);
    assert.deepEqual((h.fake.submissions[0]?.outputSchema as { required: string[] }).required, ["inputDigest", "verdict", "incidents"]);
  } finally {
    h.dispose();
  }
});

test("assistant text JSON is accepted after deterministic verification", async () => {
  const h = harness();
  try {
    const launch = h.fake.launch.bind(h.fake);
    h.fake.launch = async (input) => {
      const result = await launch(input);
      const run = h.fake.runs.get(`${result.threadId}:${result.runId}`);
      if (run) {
        run.text = `已分析。\n\`\`\`json\n${JSON.stringify({ inputDigest: digestOf, verdict: "disconnected", incidents: [
          { connectionId: "alpha", disconnectLine: 2, reconnectLine: 4 },
          { connectionId: "beta", disconnectLine: 6, reconnectLine: null },
        ] })}\n\`\`\``;
      }
      return result;
    };
    const created = h.service.createTask({ requestId: "r2", log: disconnect });
    await h.runner.runOnce();
    assert.equal(h.service.getTask(created.taskId).status, "completed");
  } finally {
    h.dispose();
  }
});

test("a forged candidate is rejected and the task fails", async () => {
  const h = harness();
  try {
    h.fake.launch = async () => {
      const threadId = "thread-forged";
      const runId = "run-forged";
      h.fake.runs.set(`${threadId}:${runId}`, {
        threadId,
        runId,
        structured: { inputDigest: digestOf, verdict: "disconnected", incidents: [{ connectionId: "alpha", disconnectLine: 2, reconnectLine: 3 }] },
      });
      return { threadId, runId, status: "running" };
    };
    const created = h.service.createTask({ requestId: "r3", log: disconnect });
    await h.runner.runOnce();
    const view = h.service.getTask(created.taskId);
    assert.equal(view.status, "failed");
    assert.equal(view.result, null);
    assert.ok(view.verification && view.verification.result === "rejected");
  } finally {
    h.dispose();
  }
});

test("healthy log passes when the candidate matches", async () => {
  const h = harness();
  try {
    h.fake.launch = async () => {
      const threadId = "thread-healthy";
      const runId = "run-healthy";
      h.fake.runs.set(`${threadId}:${runId}`, {
        threadId,
        runId,
        structured: { inputDigest: sha256Hex(healthy), verdict: "no_disconnect", incidents: [] },
      });
      return { threadId, runId, status: "running" };
    };
    const created = h.service.createTask({ requestId: "r4", log: healthy });
    await h.runner.runOnce();
    const view = h.service.getTask(created.taskId);
    assert.equal(view.status, "completed");
    assert.deepEqual((view.result as { verdict: string }).verdict, "no_disconnect");
  } finally {
    h.dispose();
  }
});

test("t3 unreachable leaves the task waiting with t3_unavailable and keeps the input", async () => {
  const h = harness();
  try {
    h.fake.failAll = new T3Error("transient", "connect: fetch failed");
    const created = h.service.createTask({ requestId: "r5", log: disconnect });
    await h.runner.runOnce();
    const view = h.service.getTask(created.taskId);
    assert.equal(view.status, "waiting");
    assert.equal(view.waitingReason, "t3_unavailable");
    assert.equal(view.inputDigest, digestOf);
  } finally {
    h.dispose();
  }
});

test("missing t3 configuration never dispatches", async () => {
  const h = harness({ t3: false });
  try {
    const created = h.service.createTask({ requestId: "r6", log: disconnect });
    await h.runner.runOnce();
    const view = h.service.getTask(created.taskId);
    assert.equal(view.status, "waiting");
    assert.equal(view.waitingReason, "t3_unavailable");
    assert.equal(h.fake.calls.length, 0);
  } finally {
    h.dispose();
  }
});

test("auth failure waits as t3_auth instead of retrying with another identity", async () => {
  const h = harness();
  try {
    h.fake.failAll = new T3Error("auth", "HTTP 401");
    const created = h.service.createTask({ requestId: "r7", log: disconnect });
    await h.runner.runOnce();
    const view = h.service.getTask(created.taskId);
    assert.equal(view.status, "waiting");
    assert.equal(view.waitingReason, "t3_auth");
  } finally {
    h.dispose();
  }
});

test("a run that never finishes is reported as effect_unknown, not failed", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-runner-"));
  const config = defaultConfig({}, home);
  const { service, db } = TaskService.open(config);
  const fake = new FakeT3();
  fake.launch = async () => {
    const threadId = "thread-slow";
    const runId = "run-slow";
    fake.runs.set(`${threadId}:${runId}`, { threadId, runId, waittimeouts: 999 });
    return { threadId, runId, status: "running" };
  };
  const runner = new TaskRunner({
    store: new TaskStore(db),
    service,
    artifacts: ArtifactStore.create(home),
    t3: t3Config,
    clientFactory: FakeT3.factory(fake),
    pollIntervalMs: 10,
    waitTimeoutMs: 5,
    runDeadlineMs: 30,
    retryPolicy: { maxSameFailure: 3, firstDelayMs: 5, maxDelayMs: 40 },
    log: () => undefined,
  });
  try {
    const created = service.createTask({ requestId: "r8", log: disconnect });
    await runner.runOnce();
    const view = service.getTask(created.taskId);
    assert.equal(view.status, "waiting");
    assert.equal(view.waitingReason, "effect_unknown");
    assert.equal(view.runId, "run-slow");
  } finally {
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("retries a transient failure, then completes", async () => {
  const h = harness();
  try {
    let attempts = 0;
    h.fake.launch = async () => {
      attempts++;
      if (attempts === 1) throw new T3Error("transient", "socket hang up");
      const threadId = "thread-retry";
      const runId = "run-retry";
      h.fake.runs.set(`${threadId}:${runId}`, {
        threadId,
        runId,
        structured: { inputDigest: digestOf, verdict: "disconnected", incidents: [
          { connectionId: "alpha", disconnectLine: 2, reconnectLine: 4 },
          { connectionId: "beta", disconnectLine: 6, reconnectLine: null },
        ] },
      });
      return { threadId, runId, status: "running" };
    };
    const created = h.service.createTask({ requestId: "r9", log: disconnect });
    await h.runner.runOnce();
    assert.equal(h.service.getTask(created.taskId).status, "completed");
    assert.equal(attempts, 2);
  } finally {
    h.dispose();
  }
});

test("restart after a completed result reads the same result back", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-runner-"));
  const config = defaultConfig({}, home);
  const fake = new FakeT3();
  fake.launch = async () => {
    const threadId = "thread-persist";
    const runId = "run-persist";
    fake.runs.set(`${threadId}:${runId}`, {
      threadId,
      runId,
      structured: { inputDigest: digestOf, verdict: "disconnected", incidents: [
        { connectionId: "alpha", disconnectLine: 2, reconnectLine: 4 },
        { connectionId: "beta", disconnectLine: 6, reconnectLine: null },
      ] },
    });
    return { threadId, runId, status: "running" };
  };
  try {
    const first = TaskService.open(config);
    const runner = new TaskRunner({
      store: new TaskStore(first.db),
      service: first.service,
      artifacts: ArtifactStore.create(home),
      t3: t3Config,
      clientFactory: FakeT3.factory(fake),
      pollIntervalMs: 10,
      waitTimeoutMs: 50,
      runDeadlineMs: 5_000,
      log: () => undefined,
    });
    const created = first.service.createTask({ requestId: "r10", log: disconnect });
    await runner.runOnce();
    const before = first.service.getTask(created.taskId);
    first.service.close();

    const second = TaskService.open(config);
    const after = second.service.getTask(created.taskId);
    assert.deepEqual(after.result, before.result);
    assert.equal(after.status, "completed");
    assert.equal(after.threadId, "thread-persist");
    second.service.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
