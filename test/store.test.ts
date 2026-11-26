import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/service/task-service.js";
import { RequestConflictError } from "../src/store/tasks.js";
import { defaultConfig } from "../src/config.js";
import { sha256Hex } from "../src/util.js";

const encoder = new TextEncoder();
const healthy = encoder.encode("2026-11-26T00:00:01Z alpha CONNECT\n2026-11-26T00:00:02Z alpha HEARTBEAT\n");
const disconnect = encoder.encode("2026-11-26T00:00:01Z alpha CONNECT\n2026-11-26T00:00:02Z alpha DISCONNECT\n2026-11-26T00:00:04Z alpha RECONNECT\n");

function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "timo-store-"));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("same request id and same bytes return the original task", () => {
  withHome((home) => {
    const config = defaultConfig({}, home);
    const { service } = TaskService.open(config);
    const first = service.createTask({ requestId: "req-1", log: healthy });
    const second = service.createTask({ requestId: "req-1", log: healthy });
    assert.equal(second.taskId, first.taskId);
    assert.equal(second.reused, true);
    assert.equal(first.status, "accepted");
    service.close();
  });
});

test("same request id with different bytes conflicts", () => {
  withHome((home) => {
    const config = defaultConfig({}, home);
    const { service } = TaskService.open(config);
    service.createTask({ requestId: "req-2", log: healthy });
    assert.throws(() => service.createTask({ requestId: "req-2", log: disconnect }), RequestConflictError);
    service.close();
  });
});

test("task survives a service restart under the same id", () => {
  withHome((home) => {
    const config = defaultConfig({}, home);
    const first = TaskService.open(config);
    const created = first.service.createTask({ requestId: "req-3", log: disconnect });
    first.service.close();

    const second = TaskService.open(config);
    const fetched = second.service.getTask(created.taskId);
    assert.equal(fetched.taskId, created.taskId);
    assert.equal(fetched.inputDigest, sha256Hex(disconnect));
    assert.equal(fetched.status, "accepted");
    assert.equal(fetched.result, null);
    assert.equal(fetched.threadId, null);
    second.service.close();
  });
});

test("incomplete input waits with input_incomplete and never dispatches", () => {
  withHome((home) => {
    const config = defaultConfig({}, home);
    const { service, db } = TaskService.open(config);
    const created = service.createTask({ requestId: "req-4", log: new Uint8Array() && encoder.encode("") });
    const view = service.getTask(created.taskId);
    assert.equal(view.status, "waiting");
    assert.equal(view.waitingReason, "input_incomplete");
    service.close();
    void db;
  });
});

test("accepted candidate is stored as the result and fails verification rejects", () => {
  withHome((home) => {
    const config = defaultConfig({}, home);
    const { service } = TaskService.open(config);
    const created = service.createTask({ requestId: "req-5", log: disconnect });
    const digest = sha256Hex(disconnect);
    const bad = service.acceptCandidate(
      created.taskId,
      { inputDigest: digest, verdict: "no_disconnect", incidents: [] },
      "run-1",
    );
    assert.equal(bad.status, "rejected");
    assert.equal(service.getTask(created.taskId).status, "failed");
    service.close();
  });
});

test("task-level accept writes a sealed result", () => {
  withHome((home) => {
    const config = defaultConfig({}, home);
    const { service } = TaskService.open(config);
    const created = service.createTask({ requestId: "req-6", log: disconnect });
    const digest = sha256Hex(disconnect);
    const good = service.acceptCandidate(
      created.taskId,
      { inputDigest: digest, verdict: "disconnected", incidents: [{ connectionId: "alpha", disconnectLine: 2, reconnectLine: 3 }] },
      "run-2",
    );
    assert.equal(good.status, "accepted");
    const view = service.getTask(created.taskId);
    assert.equal(view.status, "completed");
    assert.deepEqual(view.result, {
      verdict: "disconnected",
      incidents: [{ connectionId: "alpha", disconnectLine: 2, reconnectLine: 3 }],
      inputDigest: digest,
      verifierVersion: "sse-v1",
    });
    service.close();
  });
});

test("invalid request id is rejected as invalid input", () => {
  withHome((home) => {
    const config = defaultConfig({}, home);
    const { service } = TaskService.open(config);
    assert.throws(() => service.createTask({ requestId: "  ", log: healthy }));
    assert.throws(() => service.createTask({ requestId: "a\nb", log: healthy }));
    service.close();
  });
});
