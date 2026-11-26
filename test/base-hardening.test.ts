import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/store/artifacts.js";
import { sha256Hex } from "../src/util.js";
import { defaultConfig } from "../src/config.js";
import { acquireServiceLock, startServiceServer, ServiceUnavailableError } from "../src/ipc.js";

function withHome(fn: (home: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), "timo-step11-"));
    try {
      await fn(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
}

const chineseLog = [
  "2026-11-26T00:00:01Z 连接甲 CONNECT 建立",
  "2026-11-26T00:00:02Z 连接甲 DISCONNECT 断开",
  "2026-11-26T00:00:03Z 连接乙 CONNECT 建立",
  "2026-11-26T00:00:04Z 连接甲 RECONNECT 恢复 ✅",
].join("\n");

test(
  "multi-byte UTF-8 log keeps identical bytes and digest after freezing",
  withHome(async (home) => {
    const bytes = new TextEncoder().encode(chineseLog);
    const store = ArtifactStore.create(home);
    const { digest, path } = store.put(bytes);
    assert.equal(digest, sha256Hex(bytes));

    const readBack = store.get(path);
    assert.deepEqual(Buffer.from(readBack), Buffer.from(bytes));
    assert.equal(sha256Hex(readBack), digest);
    assert.equal(new TextDecoder().decode(readBack), chineseLog);

    // A second put of the same content must not rewrite or corrupt the file.
    const again = store.put(bytes);
    assert.equal(again.path, path);
    assert.equal(sha256Hex(readFileSync(path)), digest);
  }),
);

test(
  "stale lock from a dead pid plus leftover socket heals on start",
  withHome(async (home) => {
    const config = defaultConfig({}, home);
    // A SIGKILLed service leaves both files behind with its own now-dead pid.
    writeFileSync(`${config.socketPath}.lock`, JSON.stringify({ pid: 2 ** 22 + 1, startedAt: "2026-11-26T00:00:00.000Z" }), { mode: 0o600 });
    writeFileSync(config.socketPath, "");
    const server = await startServiceServer(config, async (request) => ({ id: request.id, ok: true, result: { healed: true } }));
    await server.close();
  }),
);

test(
  "a live lock is refused instead of being stolen",
  withHome(async (home) => {
    const config = defaultConfig({}, home);
    const lock = acquireServiceLock(config.socketPath);
    try {
      assert.throws(() => acquireServiceLock(config.socketPath), ServiceUnavailableError);
    } finally {
      lock.release();
    }
    const after = acquireServiceLock(config.socketPath);
    after.release();
  }),
);
