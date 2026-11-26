import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskService } from "../src/service/task-service.js";
import { TaskRunner } from "../src/service/runner.js";
import { TaskStore } from "../src/store/tasks.js";
import { ArtifactStore } from "../src/store/artifacts.js";
import { defaultConfig } from "../src/config.js";
import { Router, newSessionToken, startListener } from "../src/http/server.js";
import { registerApi } from "../src/http/routes.js";
import { sha256Hex } from "../src/util.js";
import { FakeT3 } from "./support/fake-t3.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "docs", "fixtures", "m1");
const t3Config = { url: "https://t3.invalid/mcp", token: "t", projectId: "proj", providerId: "codex", model: "m" };

function httpJson(url: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = init.body === undefined ? undefined : Buffer.from(JSON.stringify(init.body), "utf8");
    const req = request(
      url,
      {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
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

test("red-line pause stays paused during runner passes and resumes only after approval", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-s2-redline-"));
  const { service, db, writer, bus } = TaskService.open(defaultConfig({}, home));
  const fake = new FakeT3();
  const digest = sha256Hex(readFileSync(join(FIXTURES, "healthy.log")));
  const origLaunch = fake.launch.bind(fake);
  fake.launch = async (input) => {
    const res = await origLaunch(input);
    const run = fake.runs.get(`${res.threadId}:${res.runId}`);
    if (run) run.structured = { inputDigest: digest, verdict: "no_disconnect", incidents: [] };
    return res;
  };
  const runner = new TaskRunner({
    store: new TaskStore(db),
    service,
    artifacts: ArtifactStore.create(home),
    writer,
    bus,
    t3: t3Config,
    clientFactory: FakeT3.factory(fake),
    pollIntervalMs: 60_000,
    waitTimeoutMs: 50,
    runDeadlineMs: 5_000,
    log: () => undefined,
  });

  try {
    const created = service.createTask({ requestId: "rl-1", log: new Uint8Array(readFileSync(join(FIXTURES, "healthy.log"))) });
    const asked = service.requestAuthorization(created.taskId, { action: "deploy_prod", environment: "prod" });
    assert.equal(asked.decision, "needs_human");

    // Structured action is persisted on the inbox card (no regex parsing needed).
    const inbox = service.listInbox();
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.action, "deploy_prod");

    // Running passes MUST NOT resume a task waiting for human authorization.
    await runner.runOnce();
    assert.equal(fake.calls.includes("launch"), false);
    assert.equal(service.getTask(created.taskId).status, "waiting");
    assert.equal(service.getTask(created.taskId).waitingReason, "needs_human_decision");

    // Resolving with the wrong action is rejected.
    assert.throws(() => service.resolveAuthorization(created.taskId, { action: "other_action", approved: true }));

    // Approving enqueues resume and wakes the runner via EventBus immediately.
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    service.resolveAuthorization(created.taskId, { action: "deploy_prod", approved: true });
    for (let i = 0; i < 40; i++) {
      if (service.getTask(created.taskId).status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(service.getTask(created.taskId).status, "completed");
    // The decision_required card is cleared and replaced by the final delivery_verified card.
    const afterInbox = service.listInbox();
    assert.equal(afterInbox.some((item) => item.decisionKey === "decision_required"), false);
    assert.equal(afterInbox.some((item) => item.decisionKey === "delivery_verified"), true);
  } finally {
    await runner.stop();
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("stop clears any pending decision card from the inbox", () => {
  const home = mkdtempSync(join(tmpdir(), "timo-s2-stop-inbox-"));
  const { service } = TaskService.open(defaultConfig({}, home));
  try {
    const created = service.createTask({ requestId: "si-1", log: new Uint8Array(readFileSync(join(FIXTURES, "healthy.log"))) });
    service.requestAuthorization(created.taskId, { action: "deploy_prod" });
    assert.equal(service.listInbox().length, 1);

    service.stopTask(created.taskId);
    assert.deepEqual(service.listInbox(), []);
  } finally {
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("HTTP taskEvents returns JSON immediately, proposals list/confirm work, and stale proposal returns 409", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-s2-http-"));
  const { service, writer, bus } = TaskService.open(defaultConfig({}, home));
  const token = newSessionToken();
  const router = new Router();
  registerApi(router, { service, ledger: writer.ledger, bus, startedAt: new Date().toISOString(), t3Configured: false });
  const listener = await startListener({ router, target: { host: "127.0.0.1", port: 0 }, token });
  const base = `http://127.0.0.1:${listener.port}`;

  try {
    const created = service.createTask({ requestId: "h-1", log: new Uint8Array(readFileSync(join(FIXTURES, "healthy.log"))) });

    // JSON snapshot must return immediately (not hang for 1.5s SSE timeout).
    const t0 = Date.now();
    const eventsRes = await httpJson(`${base}/api/tasks/${created.taskId}/events?afterSeq=0&format=json`, token);
    assert.equal(eventsRes.status, 200);
    assert.ok(Date.now() - t0 < 500, "JSON events fetch must return immediately");
    assert.ok(((eventsRes.body as { events: unknown[] }).events).length >= 1);

    // Propose shorthand goal -> auto-generates diff card, visible in GET proposals.
    const propRes = await httpJson(`${base}/api/tasks/${created.taskId}/proposals`, token, {
      method: "POST",
      body: { kind: "brief", goal: "只核对 alpha 断连", reason: "测试变更" },
    });
    assert.equal(propRes.status, 201);
    const proposal = propRes.body as { proposalId: string; change: { diff: Array<{ field: string; after: string }> } };
    assert.equal(proposal.change.diff[0]?.field, "goal");
    assert.equal(proposal.change.diff[0]?.after, "只核对 alpha 断连");

    const listRes = await httpJson(`${base}/api/tasks/${created.taskId}/proposals`, token);
    assert.equal(listRes.status, 200);
    assert.equal(((listRes.body as { proposals: unknown[] }).proposals).length, 1);

    // Move task forward via amend so the pending proposal becomes stale -> must map to 409, not 500.
    service.amendTask(created.taskId, { expectedBriefVersion: 1, goal: "抢先修改" });
    const staleConfirm = await httpJson(`${base}/api/proposals/${proposal.proposalId}/confirm`, token, { method: "POST" });
    assert.equal(staleConfirm.status, 409);
    assert.equal((staleConfirm.body as { error: { code: string } }).error.code, "stale_revision");
  } finally {
    await listener.close();
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("watchdog alert does not enqueue spurious JOB_DISPATCH jobs", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-s2-wd-"));
  const { service, db, writer } = TaskService.open(defaultConfig({}, home));
  const store = new TaskStore(db);
  const runner = new TaskRunner({
    store,
    service,
    artifacts: ArtifactStore.create(home),
    writer,
    t3: null,
    clientFactory: FakeT3.factory(new FakeT3()),
    pollIntervalMs: 100,
    waitTimeoutMs: 50,
    runDeadlineMs: 5_000,
    watchdog: { stallThresholdMs: 1_000, cooldownMs: 60_000 },
    log: () => undefined,
  });

  try {
    const created = service.createTask({ requestId: "wd-1", log: new Uint8Array(readFileSync(join(FIXTURES, "healthy.log"))) });
    const oldTime = new Date(Date.now() - 10_000).toISOString();
    store.setThread(created.taskId, "thr_1", oldTime);
    store.setRun(created.taskId, "run_1", oldTime);
    store.setStatus(created.taskId, "running", null, oldTime);
    store.setEvidence(created.taskId, "lastActivityAt", oldTime, oldTime);
    store.setEvidence(created.taskId, "runStartedAt", oldTime, oldTime);
    // Complete initial dispatch job so we can assert watchdog doesn't enqueue another one.
    for (const job of writer.outbox.byTask(created.taskId)) writer.outbox.complete(job.jobId);

    const beforeCount = writer.outbox.byTask(created.taskId).length;
    await runner.runOnce();
    const signals = writer.ledger.forTask(created.taskId).filter((e) => e.type === "watchdog_signal");
    assert.equal(signals.length, 1);
    assert.equal(writer.outbox.byTask(created.taskId).length, beforeCount);
  } finally {
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
});
