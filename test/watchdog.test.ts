import { test } from "node:test";
import assert from "node:assert/strict";
import { WatchdogMonitor, DEFAULT_THRESHOLDS, type WatchdogObservation } from "../src/watchdog/monitor.js";

const T0 = Date.parse("2026-11-26T00:00:00.000Z");
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);

function observation(overrides: Partial<WatchdogObservation> = {}): WatchdogObservation {
  return {
    taskId: "task-1",
    status: "running",
    waitingReason: null,
    lastActivityAt: new Date(T0).toISOString(),
    runStartedAt: new Date(T0).toISOString(),
    hasProgress: true,
    failureFingerprints: [],
    changedFiles: [],
    ...overrides,
  };
}

test("stall fires once silence exceeds the threshold", () => {
  const monitor = new WatchdogMonitor({ stallThresholdMs: 3 * 60_000 });
  const quiet = observation();
  // Just under the threshold: nothing.
  assert.deepEqual(monitor.scan([quiet], at(2.9)).signals, []);
  const report = monitor.scan([quiet], at(4));
  assert.equal(report.signals.length, 1);
  assert.equal(report.signals[0]!.kind, "stall");
  assert.equal(report.modelCalls, 0);
});

test("loop fires on the third identical failure fingerprint", () => {
  const monitor = new WatchdogMonitor({ maxSameFailure: 3 });
  const base = observation({ lastActivityAt: at(10).toISOString() });
  const two = observation({ ...base, failureFingerprints: ["E_TEST", "E_TEST"] });
  assert.deepEqual(monitor.scan([two], at(11)).signals, []);
  const three = observation({ ...base, failureFingerprints: ["E_TEST", "E_TEST", "E_TEST"] });
  const report = monitor.scan([three], at(12));
  assert.equal(report.signals.filter((signal) => signal.kind === "loop").length, 1);
});

test("loop does not fire on different fingerprints", () => {
  const monitor = new WatchdogMonitor({ maxSameFailure: 3 });
  const mixed = observation({
    lastActivityAt: at(10).toISOString(),
    failureFingerprints: ["A", "B", "A", "B"],
  });
  assert.equal(monitor.scan([mixed], at(11)).signals.filter((signal) => signal.kind === "loop").length, 0);
});

test("soft_deadline fires when no candidate appears past the deadline", () => {
  const monitor = new WatchdogMonitor({ softDeadlineMs: 45 * 60_000, stallThresholdMs: 999 * 60_000 });
  const noProgress = observation({ hasProgress: false, lastActivityAt: at(44).toISOString() });
  assert.equal(monitor.scan([noProgress], at(44)).signals.filter((signal) => signal.kind === "soft_deadline").length, 0);
  const late = observation({ hasProgress: false, lastActivityAt: at(50).toISOString() });
  const report = monitor.scan([late], at(50));
  assert.equal(report.signals.filter((signal) => signal.kind === "soft_deadline").length, 1);
});

test("soft_deadline stays quiet once progress exists", () => {
  const monitor = new WatchdogMonitor({ softDeadlineMs: 10 * 60_000, stallThresholdMs: 999 * 60_000 });
  const progressed = observation({ hasProgress: true, lastActivityAt: at(60).toISOString() });
  assert.equal(monitor.scan([progressed], at(60)).signals.filter((signal) => signal.kind === "soft_deadline").length, 0);
});

test("scope_drift fires on too many files and on paths outside the whitelist", () => {
  const monitor = new WatchdogMonitor({ maxChangedFiles: 5, allowedPathPrefixes: ["src/"] });
  const many = observation({ changedFiles: Array.from({ length: 6 }, (_, index) => `src/f${index}.ts`) });
  assert.equal(monitor.scan([many], at(1)).signals.filter((signal) => signal.kind === "scope_drift").length, 1);

  const outsideMonitor = new WatchdogMonitor({ maxChangedFiles: 100, allowedPathPrefixes: ["src/"] });
  const outside = observation({ changedFiles: ["src/ok.ts", "etc/passwd"] });
  const report = outsideMonitor.scan([outside], at(1));
  assert.equal(report.signals.filter((signal) => signal.kind === "scope_drift").length, 1);
  assert.match(report.signals.find((signal) => signal.kind === "scope_drift")!.detail, /etc\/passwd/);
});

test("an in-scope change set produces no drift", () => {
  const monitor = new WatchdogMonitor({ maxChangedFiles: 40, allowedPathPrefixes: ["src/"] });
  const clean = observation({ changedFiles: ["src/a.ts", "src/b.ts"] });
  assert.deepEqual(monitor.scan([clean], at(1)).signals, []);
});

test("a legitimate waiting_external_ci wait of 30 minutes is never a stall", () => {
  const monitor = new WatchdogMonitor({ stallThresholdMs: 3 * 60_000, softDeadlineMs: 10 * 60_000 });
  const waiting = observation({
    status: "waiting",
    waitingReason: "waiting_external_ci",
    lastActivityAt: at(0).toISOString(),
    hasProgress: false,
  });
  const report = monitor.scan([waiting], at(30));
  assert.deepEqual(report.signals, []);
  assert.equal(report.summaries[0]!.status, "healthy");
});

test("needs_human_decision is also exempt from stall", () => {
  const monitor = new WatchdogMonitor({ stallThresholdMs: 60_000 });
  const parked = observation({ status: "waiting", waitingReason: "needs_human_decision" });
  assert.deepEqual(monitor.scan([parked], at(60)).signals, []);
});

test("a running task silently waiting is not exempt", () => {
  const monitor = new WatchdogMonitor({ stallThresholdMs: 60_000 });
  const stuck = observation({ status: "running", waitingReason: null });
  assert.equal(monitor.scan([stuck], at(5)).signals.length, 1);
});

test("the same window is alerted once inside the cooldown", () => {
  const monitor = new WatchdogMonitor({ stallThresholdMs: 60_000, cooldownMs: 10 * 60_000 });
  const stuck = observation();
  assert.equal(monitor.scan([stuck], at(2)).signals.length, 1);
  // Second scan inside the cooldown window: suppressed.
  assert.equal(monitor.scan([stuck], at(5)).signals.length, 0);
  // After the cooldown, it alerts again.
  assert.equal(monitor.scan([stuck], at(20)).signals.length, 1);
});

test("the scan never reports a model call", () => {
  const monitor = new WatchdogMonitor({ stallThresholdMs: 1 });
  const report = monitor.scan([observation({ status: "running", failureFingerprints: ["x", "x", "x"] })], at(5));
  assert.equal(report.modelCalls, 0);
  assert.ok(report.signals.length >= 1);
});

test("defaults are conservative", () => {
  assert.ok(DEFAULT_THRESHOLDS.stallThresholdMs >= 60_000);
  assert.equal(DEFAULT_THRESHOLDS.maxSameFailure, 3);
});
