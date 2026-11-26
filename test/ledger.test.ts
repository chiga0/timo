import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/service/task-service.js";
import { defaultConfig } from "../src/config.js";
import { EventLedger } from "../src/events/ledger.js";
import { JOB_DISPATCH, Outbox } from "../src/events/index.js";
import type { TaskEvent } from "../src/events/types.js";

const log = () => new TextEncoder().encode("2026-11-26T00:00:01Z alpha CONNECT\n2026-11-26T00:00:02Z alpha DISCONNECT\n");

interface Opened {
  home: string;
  opened: ReturnType<typeof TaskService.open>;
}

/** Runs `fn` against one fresh TIMO_HOME and closes every service it opened. */
async function withHome(fn: (env: Opened) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "timo-ledger-"));
  const opened = TaskService.open(defaultConfig({}, home));
  try {
    await fn({ home, opened });
  } finally {
    try {
      opened.service.close();
    } catch {
      // the test may already have closed and reopened it
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("every business transition lands in task_events with a monotonic seq", async () => {
  await withHome(async ({ opened: { service, writer } }) => {
    const created = service.createTask({ requestId: "ledger-1", log: log() });
    service.markWaiting(created.taskId, "t3_unavailable");
    service.acceptCandidate(
      created.taskId,
      {
        inputDigest: service.getTask(created.taskId).inputDigest,
        verdict: "disconnected",
        incidents: [{ connectionId: "alpha", disconnectLine: 2, reconnectLine: null }],
      },
      "run-ledger",
    );
    const events = writer.ledger.forTask(created.taskId);
    const seqs = events.map((event) => event.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
    assert.deepEqual(
      events.map((event) => event.type),
      ["task_created", "task_waiting", "task_completed"],
    );
    const replayAll = writer.ledger.afterSeq(0).filter((event) => event.taskId === created.taskId);
    assert.deepEqual(replayAll.map((event) => event.seq), seqs);
  });
});

test("appending the same idempotency key twice produces one event", async () => {
  await withHome(async ({ opened: { service, writer } }) => {
    const created = service.createTask({ requestId: "ledger-2", log: log() });
    const before = writer.ledger.forTask(created.taskId).length;
    const first = writer.commit({
      taskId: created.taskId,
      type: "task_waiting",
      payload: { waitingReason: "t3_auth" },
      options: { idempotencyKey: "dup-key" },
    });
    const second = writer.commit({
      taskId: created.taskId,
      type: "task_waiting",
      payload: { waitingReason: "t3_auth" },
      options: { idempotencyKey: "dup-key" },
    });
    const after = writer.ledger.forTask(created.taskId);
    assert.equal(after.length, before + 1);
    assert.equal(after.filter((event) => event.idempotencyKey === "dup-key").length, 1);
    // The replay of a duplicate returns the original event, not a new seq.
    assert.equal(second.seq, first.seq);
    assert.equal(second.eventId, first.eventId);
  });
});

test("a rolled back transition never publishes to the event bus", async () => {
  await withHome(async ({ opened: { db, bus, writer, service } }) => {
    const created = service.createTask({ requestId: "ledger-3", log: log() });
    const published: TaskEvent[] = [];
    bus.on("*", (event) => published.push(event));
    const baseline = writer.ledger.latestSeq();

    assert.throws(() =>
      db.transaction(() => {
        writer.commit({
          taskId: created.taskId,
          type: "task_waiting",
          payload: { waitingReason: "t3_auth" },
          options: { idempotencyKey: "rollback-key" },
          project: () => {
            throw new Error("projection failed");
          },
        });
      }),
    );

    // Nothing committed means nothing broadcast and nothing readable.
    assert.equal(published.length, 0);
    assert.equal(writer.ledger.latestSeq(), baseline);
    assert.equal(writer.ledger.afterSeq(0).filter((event) => event.idempotencyKey === "rollback-key").length, 0);
    assert.equal(service.getTask(created.taskId).waitingReason, null);
  });
});

test("an expired lease is re-claimable by a new instance", async () => {
  await withHome(async ({ opened: { service, writer } }) => {
    const created = service.createTask({ requestId: "ledger-4", log: log() });
    const outbox: Outbox = writer.outbox;
    const existing = outbox.byTask(created.taskId).find((job) => job.kind === JOB_DISPATCH);
    assert.ok(existing);
    // Park the initial job so the lease assertions below use a known baseline.
    outbox.complete(existing.jobId);

    const job = outbox.enqueue({
      taskId: created.taskId,
      kind: JOB_DISPATCH,
      dedupeKey: "lease-probe",
      now: "2026-11-26T00:00:00.000Z",
      runAfter: "2026-11-26T00:00:00.000Z",
    });

    const claimed = outbox.claim({ owner: "process-a", now: "2026-11-26T00:00:00.000Z", limit: 10, leaseMs: 1_000 });
    const mine = claimed.filter((item) => item.jobId === job.jobId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.leaseOwner, "process-a");

    // Before expiry another owner cannot take the same job.
    const early = outbox.claim({ owner: "process-b", now: "2026-11-26T00:00:00.500Z", limit: 10, leaseMs: 1_000 });
    assert.equal(early.filter((item) => item.jobId === job.jobId).length, 0);

    // After expiry the dead owner's lease is stolen and the attempt is counted.
    const late = outbox.claim({ owner: "process-b", now: "2026-11-26T00:00:02.000Z", limit: 10, leaseMs: 1_000 });
    const stolen = late.filter((item) => item.jobId === job.jobId);
    assert.equal(stolen.length, 1);
    assert.equal(stolen[0]?.leaseOwner, "process-b");
    assert.equal(stolen[0]?.attempts, 2);
  });
});

test("afterSeq replay matches the full state", async () => {
  await withHome(async ({ opened: { service, writer } }) => {
    const a = service.createTask({ requestId: "ledger-5a", log: log() });
    const b = service.createTask({ requestId: "ledger-5b", log: log() });
    service.markWaiting(b.taskId, "t3_auth");
    void a;

    const all = writer.ledger.afterSeq(0);
    assert.ok(all.length >= 3);
    const pivot = all[0]!.seq;
    const incremental = writer.ledger.afterSeq(pivot);
    assert.deepEqual(
      [...all.filter((event) => event.seq <= pivot), ...incremental].map((event) => event.seq),
      all.map((event) => event.seq),
    );
    assert.equal(new Set(all.map((event) => event.eventId)).size, all.length);
  });
});

test("ledger read after a restart sees the same committed history", async () => {
  await withHome(async ({ home, opened }) => {
    const created = opened.service.createTask({ requestId: "ledger-6", log: log() });
    opened.service.markWaiting(created.taskId, "t3_auth");
    const before = opened.writer.ledger.forTask(created.taskId).map((event) => [event.seq, event.type]);
    opened.service.close();

    const reopened = TaskService.open(defaultConfig({}, home));
    try {
      const after = reopened.writer.ledger.forTask(created.taskId).map((event) => [event.seq, event.type]);
      assert.deepEqual(after, before);
      assert.equal(reopened.service.getTask(created.taskId).waitingReason, "t3_auth");
      const ledger = new EventLedger(reopened.db);
      assert.equal(ledger.latestSeq(), before[before.length - 1]?.[0]);
    } finally {
      reopened.service.close();
    }
  });
});
