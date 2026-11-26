import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter } from "../src/adapters/pi.js";
import { ExecutorRegistry, ExecutorUnavailableError, type RunStreamEvent } from "../src/adapters/execution.js";
import { RunStreamStore } from "../src/workspace/run-stream.js";

/** Writes a fake `pi` CLI so the adapter is tested without a model. */
function fakePi(dir: string, script: string): string {
  const path = join(dir, "fake-pi.sh");
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return path;
}

const CWD = () => mkdtempSync(join(tmpdir(), "timo-pi-cwd-"));

test("streams JSONL lines into normalised events and returns the final text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timo-pi-"));
  try {
    const cli = fakePi(
      dir,
      [
        `echo '{"type":"session","id":"sess-1"}'`,
        `echo '{"type":"agent_start"}'`,
        `echo '{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","name":"read","input":{"path":"a"}}]}}'`,
        `echo '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"最终答案 ok"}]}}'`,
        `echo '{"type":"agent_settled","aborted":false}'`,
        "exit 0",
      ].join("\n"),
    );
    const adapter = new PiAdapter({ command: cli });
    const cwd = CWD();
    const events: RunStreamEvent[] = [];
    const result = await adapter.spawn({ taskId: "t1", runId: "r1", cwd, prompt: "hi" }, (event) => events.push(event));

    assert.equal(result.status, "succeeded");
    assert.equal(result.exitCode, 0);
    assert.equal(result.externalId, "sess-1");
    assert.equal(result.output, "最终答案 ok");

    const types = events.map((event) => event.type);
    assert.ok(types.includes("status"));
    assert.ok(types.includes("tool_call"));
    assert.ok(types.includes("thinking"));
    // Sequence numbers are monotonic starting at 1.
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index + 1),
    );
    rmSync(cwd, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-zero exit is reported as failed with the stderr tail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timo-pi-"));
  try {
    const cli = fakePi(dir, [`echo 'boom: model unavailable' >&2`, "exit 3"].join("\n"));
    const adapter = new PiAdapter({ command: cli });
    const cwd = CWD();
    const events: RunStreamEvent[] = [];
    const result = await adapter.spawn({ taskId: "t2", runId: "r2", cwd, prompt: "x" }, (event) => events.push(event));

    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 3);
    assert.ok(events.some((event) => event.type === "error" && event.summary.includes("model unavailable")));
    rmSync(cwd, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed line is preserved as a shell event instead of being dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timo-pi-"));
  try {
    const cli = fakePi(dir, ["echo 'not json at all'", "exit 0"].join("\n"));
    const adapter = new PiAdapter({ command: cli });
    const cwd = CWD();
    const events: RunStreamEvent[] = [];
    await adapter.spawn({ taskId: "t3", runId: "r3", cwd, prompt: "x" }, (event) => events.push(event));
    assert.ok(events.some((event) => event.type === "shell" && event.summary.includes("not json")));
    rmSync(cwd, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a process that dies mid-run is reported, not silently treated as success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timo-pi-"));
  try {
    // Emit one line then kill ourselves with a signal.
    const cli = fakePi(dir, [`echo '{"type":"agent_start"}'`, "kill -9 $$"].join("\n"));
    const adapter = new PiAdapter({ command: cli });
    const cwd = CWD();
    const events: RunStreamEvent[] = [];
    const result = await adapter.spawn({ taskId: "t4", runId: "r4", cwd, prompt: "x" }, (event) => events.push(event));
    assert.notEqual(result.status, "succeeded");
    assert.ok(events.some((event) => event.type === "error"));
    rmSync(cwd, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interrupt terminates the live child and reports interrupted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timo-pi-"));
  try {
    const cli = fakePi(dir, [`echo '{"type":"agent_start"}'`, "sleep 30"].join("\n"));
    const adapter = new PiAdapter({ command: cli });
    const cwd = CWD();
    const events: RunStreamEvent[] = [];
    const running = adapter.spawn({ taskId: "t5", runId: "r5", cwd, prompt: "x" }, (event) => events.push(event));
    // Give the child a moment to start, then interrupt it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const interrupted = await adapter.interrupt("r5");
    assert.equal(interrupted.interrupted, true);
    const result = await running;
    assert.equal(result.status, "interrupted");

    // Interrupting again is a no-op rather than an error.
    assert.equal((await adapter.interrupt("r5")).interrupted, false);
    rmSync(cwd, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe reports unavailable when the CLI is missing", async () => {
  const adapter = new PiAdapter({ command: "/nonexistent/pi-binary" });
  const descriptor = await adapter.probe();
  assert.equal(descriptor.available, false);
  assert.match(descriptor.reason ?? "", /not found/);
});

test("the registry refuses an unavailable executor instead of falling back", async () => {
  const registry = new ExecutorRegistry();
  registry.register(new PiAdapter({ command: "/nonexistent/pi-binary" }));
  await registry.probeAll();
  assert.throws(() => registry.require("pi"), (error: Error) => error instanceof ExecutorUnavailableError);
  assert.throws(() => registry.require("codex"), (error: Error) => error instanceof ExecutorUnavailableError);
});

test("the run stream store appends NDJSON outside the event ledger and replays it", () => {
  const home = mkdtempSync(join(tmpdir(), "timo-runs-"));
  try {
    const store = new RunStreamStore(home);
    const base: Omit<RunStreamEvent, "seq" | "type" | "summary"> = { runId: "run-1", taskId: "task-1", at: Date.now() };
    store.append({ ...base, seq: 1, type: "status", summary: "started" });
    store.append({ ...base, seq: 2, type: "tool_call", summary: "read a.ts" });
    store.append({ ...base, seq: 3, type: "thinking", summary: "done" });

    const path = store.pathFor("task-1", "run-1");
    assert.ok(existsSync(path));
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 3);

    assert.deepEqual(store.read("task-1", "run-1").map((event) => event.seq), [1, 2, 3]);
    assert.deepEqual(store.read("task-1", "run-1", 2).map((event) => event.seq), [3]);
    assert.deepEqual(store.listRuns("task-1"), ["run-1"]);

    // The store only touches its own directory, never a task_events table.
    assert.equal(existsSync(join(home, "runs", "task-1", "run-1.ndjson")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("run ids cannot escape the runs directory", () => {
  const home = mkdtempSync(join(tmpdir(), "timo-runs-"));
  try {
    const store = new RunStreamStore(home);
    const path = store.pathFor("../../etc", "../../passwd");
    assert.ok(path.startsWith(home), `escaped to ${path}`);
    assert.equal(path.includes(".."), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
