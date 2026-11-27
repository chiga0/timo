import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.js";
import { TaskService } from "../src/service/task-service.js";
import { TaskStore } from "../src/store/tasks.js";
import { renderS07ComparisonReport } from "../src/metrics/efficiency.js";
import { Router, startListener, newSessionToken } from "../src/http/server.js";
import { registerApi } from "../src/http/routes.js";

test("Step 6.1 (S07): aggregate and per-task efficiency metrics track verified rate, silent grants, interruptions, and honest unknown cost", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-s6-metrics-"));
  const config = defaultConfig({}, home);
  const { service, db, bus, writer } = TaskService.open(config);
  const store = new TaskStore(db);

  const token = newSessionToken();
  const router = new Router();
  registerApi(router, {
    service,
    ledger: writer.ledger,
    bus,
    startedAt: new Date().toISOString(),
    t3Configured: false,
  });
  const server = await startListener({ router, target: { host: "127.0.0.1", port: 0 }, token });

  try {
    // Task 1: Tier 1 silent grant + verified completion.
    const t1 = service.createTask({
      requestId: "s6-m1",
      log: new TextEncoder().encode("2026-11-27T00:00:01Z alpha CONNECT\n2026-11-27T00:00:02Z alpha HEARTBEAT\n"),
    });
    service.requestAuthorization(t1.taskId, { action: "open_pull_request", environment: "dev" });
    service.acceptCandidate(
      t1.taskId,
      { inputDigest: service.getTask(t1.taskId).inputDigest, verdict: "no_disconnect", incidents: [] },
      "r1",
    );

    // Task 2: Tier 2 red-line interruption + declined -> failed.
    const t2 = service.createTask({
      requestId: "s6-m2",
      log: new TextEncoder().encode("2026-11-27T00:00:01Z beta CONNECT\n2026-11-27T00:00:02Z beta HEARTBEAT\n"),
    });
    service.requestAuthorization(t2.taskId, { action: "deploy_prod", environment: "prod" });
    service.resolveAuthorization(t2.taskId, { action: "deploy_prod", approved: false });

    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: `Bearer ${token}` };

    const res = await fetch(`${base}/api/metrics`, { headers });
    assert.equal(res.status, 200);
    const metrics = (await res.json()) as ReturnType<TaskService["efficiencyMetrics"]>;

    assert.equal(metrics.totalTasks, 2);
    assert.equal(metrics.terminalTasks, 2);
    assert.equal(metrics.verifiedCompletedTasks, 1);
    assert.equal(metrics.failedTasks, 1);
    assert.equal(metrics.verifiedDeliveryRate, 0.5);
    assert.equal(metrics.totalSilentAutoGrants, 1);
    assert.equal(metrics.totalHumanInterruptions, 1);
    assert.equal(metrics.inboxTelemetryLeaks, 0);
    // Unmetered cost MUST remain explicitly unknown, never 0!
    assert.equal(metrics.costUsd, null);
    assert.equal(metrics.costStatus, "unknown_unmetered");

    const singleRes = await fetch(`${base}/api/tasks/${t1.taskId}/metrics`, { headers });
    assert.equal(singleRes.status, 200);
    const single = (await singleRes.json()) as { verifiedCompleted: boolean; silentAutoGrants: number; humanInterruptions: number };
    assert.equal(single.verifiedCompleted, true);
    assert.equal(single.silentAutoGrants, 1);
    assert.equal(single.humanInterruptions, 0);

    const report = renderS07ComparisonReport(
      metrics,
      { humanMinutes: 3, manualStatusChecks: 1, repeatedExplanations: 0 },
      {
        label: "纯手工终端基线",
        executorId: "qwen-code",
        totalTasks: 2,
        verifiedCompletedTasks: 1,
        avgDurationMs: 180_000,
        humanMinutes: 18,
        manualStatusChecks: 9,
        repeatedExplanations: 3,
        interruptions: 6,
        costUsd: null,
      },
    );
    assert.match(report, /独立验收通过率/);
    assert.match(report, /未知（未计量，不记零）/);
    assert.match(report, /总助理静默放行/);
    void store;
  } finally {
    await server.close();
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
});
