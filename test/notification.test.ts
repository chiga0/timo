import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/service/task-service.js";
import { TaskStore } from "../src/store/tasks.js";
import { defaultConfig } from "../src/config.js";

const log = () => new TextEncoder().encode("2026-11-26T00:00:01Z alpha CONNECT\n");

test("repeated undelivered notifications of one kind are recorded separately", () => {
  const home = mkdtempSync(join(tmpdir(), "timo-notify-"));
  try {
    const { service, db } = TaskService.open(defaultConfig({}, home));
    const created = service.createTask({ requestId: "n1", log: log() });
    const store = new TaskStore(db);
    store.enqueueNotification(created.taskId, "waiting_t3_auth", { attempt: 1 }, "2026-01-01T00:00:01.000Z");
    store.enqueueNotification(created.taskId, "waiting_t3_auth", { attempt: 2 }, "2026-01-01T00:00:02.000Z");
    const pending = store.undeliveredNotifications(created.taskId);
    assert.equal(pending.length, 2);
    assert.deepEqual(
      pending.map((item) => item.body),
      [{ attempt: 1 }, { attempt: 2 }],
    );

    // Delivering the first batch allows the next one to be queued as history.
    store.markNotificationsDelivered(created.taskId, "2026-01-01T00:00:03.000Z");
    store.enqueueNotification(created.taskId, "waiting_t3_auth", { attempt: 3 }, "2026-01-01T00:00:04.000Z");
    assert.equal(store.undeliveredNotifications(created.taskId).length, 1);
    service.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
