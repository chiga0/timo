import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeLog, verifyCandidate } from "../src/sse/contract.js";
import { sha256Hex } from "../src/util.js";

const encoder = new TextEncoder();

const disconnect = encoder.encode(
  [
    "2026-11-26T00:00:01Z alpha CONNECT",
    "2026-11-26T00:00:02Z alpha DISCONNECT",
    "2026-11-26T00:00:03Z beta CONNECT",
    "2026-11-26T00:00:04Z alpha RECONNECT",
    "2026-11-26T00:00:05Z alpha HEARTBEAT",
    "2026-11-26T00:00:06Z beta DISCONNECT",
    "",
  ].join("\n"),
);

const healthy = encoder.encode(
  ["2026-11-26T00:00:01Z alpha CONNECT", "2026-11-26T00:00:02Z alpha HEARTBEAT", "2026-11-26T00:00:03Z alpha HEARTBEAT", ""].join("\n"),
);

test("disconnect sample yields two incidents ordered by line", () => {
  const result = analyzeLog(new TextDecoder().decode(disconnect));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.verdict, "disconnected");
  assert.deepEqual(result.incidents, [
    { connectionId: "alpha", disconnectLine: 2, reconnectLine: 4 },
    { connectionId: "beta", disconnectLine: 6, reconnectLine: null },
  ]);
});

test("blank lines keep their line number", () => {
  const text = "2026-11-26T00:00:01Z alpha CONNECT\n\n2026-11-26T00:00:02Z alpha DISCONNECT\n\n2026-11-26T00:00:03Z alpha RECONNECT\n";
  const result = analyzeLog(text);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.incidents, [{ connectionId: "alpha", disconnectLine: 3, reconnectLine: 5 }]);
});

test("no disconnect sample passes", () => {
  const digest = sha256Hex(healthy);
  const outcome = verifyCandidate(healthy, digest, { inputDigest: digest, verdict: "no_disconnect", incidents: [] });
  assert.equal(outcome.status, "accepted");
});

test("empty input is incomplete, not a silent pass", () => {
  const bytes = new Uint8Array();
  const outcome = verifyCandidate(bytes, sha256Hex(bytes), { inputDigest: sha256Hex(bytes), verdict: "no_disconnect", incidents: [] });
  assert.equal(outcome.status, "incomplete");
});

test("malformed line is incomplete", () => {
  const bytes = encoder.encode("2026-11-26T00:00:01Z alpha CONNECT\nnot a line\n");
  const outcome = verifyCandidate(bytes, sha256Hex(bytes), { inputDigest: sha256Hex(bytes), verdict: "no_disconnect", incidents: [] });
  assert.equal(outcome.status, "incomplete");
  if (outcome.status === "incomplete") assert.equal(outcome.findings[0]?.code, "input_incomplete");
});

test("forged reconnect line is rejected", () => {
  const digest = sha256Hex(disconnect);
  const outcome = verifyCandidate(disconnect, digest, {
    inputDigest: digest,
    verdict: "disconnected",
    incidents: [
      { connectionId: "alpha", disconnectLine: 2, reconnectLine: 3 },
      { connectionId: "beta", disconnectLine: 6, reconnectLine: null },
    ],
  });
  assert.equal(outcome.status, "rejected");
  if (outcome.status === "rejected") assert.ok(outcome.findings.some((finding) => finding.code === "line_mismatch"));
});

test("mismatched digest is rejected", () => {
  const outcome = verifyCandidate(disconnect, sha256Hex(disconnect), {
    inputDigest: "0".repeat(64),
    verdict: "disconnected",
    incidents: [
      { connectionId: "alpha", disconnectLine: 2, reconnectLine: 4 },
      { connectionId: "beta", disconnectLine: 6, reconnectLine: null },
    ],
  });
  assert.equal(outcome.status, "rejected");
  if (outcome.status === "rejected") assert.ok(outcome.findings.some((finding) => finding.code === "digest_mismatch"));
});

test("missed incident is rejected", () => {
  const digest = sha256Hex(disconnect);
  const outcome = verifyCandidate(disconnect, digest, {
    inputDigest: digest,
    verdict: "disconnected",
    incidents: [{ connectionId: "alpha", disconnectLine: 2, reconnectLine: 4 }],
  });
  assert.equal(outcome.status, "rejected");
  if (outcome.status === "rejected") assert.ok(outcome.findings.some((finding) => finding.code === "incident_missed"));
});

test("claiming completion for a healthy log with a stale verdict is rejected", () => {
  const digest = sha256Hex(healthy);
  const outcome = verifyCandidate(healthy, digest, { inputDigest: digest, verdict: "disconnected", incidents: [] });
  assert.equal(outcome.status, "rejected");
});

test("earliest still-open disconnect is matched first", () => {
  const text = [
    "2026-11-26T00:00:01Z c DISCONNECT",
    "2026-11-26T00:00:02Z c DISCONNECT",
    "2026-11-26T00:00:03Z c RECONNECT",
  ].join("\n");
  const result = analyzeLog(text);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.incidents, [
    { connectionId: "c", disconnectLine: 1, reconnectLine: 3 },
    { connectionId: "c", disconnectLine: 2, reconnectLine: null },
  ]);
});
