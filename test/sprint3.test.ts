import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.js";
import { TaskService } from "../src/service/task-service.js";
import { TaskRunner } from "../src/service/runner.js";
import { TaskStore } from "../src/store/tasks.js";
import { ArtifactStore } from "../src/store/artifacts.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { RunStreamStore } from "../src/workspace/run-stream.js";
import {
  ExecutorRegistry,
  buildIsolatedWorkerEnv,
  type ExecutionAdapter,
  type ExecutorDescriptor,
  type RunStreamEvent,
  type SpawnRequest,
  type SpawnResult,
} from "../src/adapters/execution.js";
import { Router, startListener, newSessionToken } from "../src/http/server.js";
import { registerApi } from "../src/http/routes.js";
import { computeRepoCandidateDigest } from "../src/verify/pipeline.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
};

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

function makeCodeRepo(root: string, name: string, initialCode: string): string {
  const repoDir = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", repoDir], { env: GIT_ENV });
  writeFileSync(join(repoDir, "app.mjs"), initialCode);
  writeFileSync(
    join(repoDir, "check.mjs"),
    `import { value } from "./app.mjs";
if (value !== 42) {
  console.error("Expected value=42, got", value);
  process.exit(1);
}
console.log("CHECK_OK");
`,
  );
  git(["add", "."], repoDir);
  git(["commit", "-qm", "init"], repoDir);
  return repoDir;
}

class ScriptedAdapter implements ExecutionAdapter {
  readonly id: string;
  readonly steered: Array<{ runId: string; message: string }> = [];
  readonly interrupted: string[] = [];
  calls = 0;
  private readonly handlers = new Map<string, () => void>();

  constructor(
    id: string,
    private readonly onSpawn: (
      request: SpawnRequest,
      emit: (event: Omit<RunStreamEvent, "seq" | "runId" | "taskId" | "at">) => void,
      callIndex: number,
      waitForSteerOrInterrupt: () => Promise<void>,
    ) => Promise<Partial<SpawnResult> | void>,
    private readonly available = true,
  ) {
    this.id = id;
  }

  async probe(): Promise<ExecutorDescriptor> {
    return {
      id: this.id,
      kind: "cli",
      available: this.available,
      reason: this.available ? "ready (scripted)" : "binary missing",
      capabilities: { steer: true, resume: false, stream: true },
    };
  }

  async spawn(request: SpawnRequest, onEvent: (event: RunStreamEvent) => void): Promise<SpawnResult> {
    this.calls += 1;
    let seq = 0;
    const emit = (ev: Omit<RunStreamEvent, "seq" | "runId" | "taskId" | "at">) => {
      seq += 1;
      onEvent({ seq, runId: request.runId, taskId: request.taskId, at: Date.now(), ...ev });
    };
    const waitForSteerOrInterrupt = () =>
      new Promise<void>((resolve) => {
        this.handlers.set(request.runId, resolve);
      });
    try {
      const partial = (await this.onSpawn(request, emit, this.calls, waitForSteerOrInterrupt)) ?? {};
      return {
        runId: request.runId,
        externalId: partial.externalId ?? `ext-${request.runId}`,
        status: partial.status ?? "succeeded",
        exitCode: partial.exitCode ?? 0,
        output: partial.output ?? "done",
      };
    } finally {
      this.handlers.delete(request.runId);
    }
  }

  async resume(): Promise<SpawnResult> {
    throw new Error("not supported");
  }

  async steer(runId: string, message: string): Promise<{ accepted: boolean; reason?: string }> {
    this.steered.push({ runId, message });
    this.handlers.get(runId)?.();
    return { accepted: true };
  }

  async interrupt(runId: string): Promise<{ interrupted: boolean; reason?: string }> {
    this.interrupted.push(runId);
    this.handlers.get(runId)?.();
    return { interrupted: true };
  }
}

function setupHarness(adapter: ExecutionAdapter, extraAdapters: ExecutionAdapter[] = []) {
  const home = mkdtempSync(join(tmpdir(), "timo-s3-"));
  const config = defaultConfig({ TIMO_POLL_INTERVAL_MS: "50" }, home);
  const { service, db, bus, writer } = TaskService.open(config);
  const store = new TaskStore(db);
  const artifacts = ArtifactStore.create(home);
  const workspaces = new WorkspaceManager({ home: join(home, "workspaces") });
  const runStreams = new RunStreamStore(home);
  const executors = new ExecutorRegistry();
  executors.register(adapter);
  for (const extra of extraAdapters) executors.register(extra);

  const runner = new TaskRunner({
    store,
    service,
    artifacts,
    writer,
    bus,
    t3: null,
    clientFactory: () => Promise.reject(new Error("t3 unused")),
    pollIntervalMs: 50,
    waitTimeoutMs: 200,
    runDeadlineMs: 30_000,
    runStreams,
    executors,
    workspaces,
    verifiers: service.verifiers,
    log: () => undefined,
  });

  return {
    home,
    service,
    store,
    bus,
    writer,
    workspaces,
    runStreams,
    executors,
    runner,
    dispose: async () => {
      await runner.stop();
      service.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("Step 3.2: live run stream writes NDJSON + SSE and updates watchdog without polluting task_events or inbox", async () => {
  const adapter = new ScriptedAdapter("mock-cli", async (req, emit, _call, waitSignal) => {
    emit({ type: "status", summary: "booting mock-cli" });
    emit({ type: "tool_call", summary: "read app.mjs", data: { path: "app.mjs" } });
    emit({ type: "patch", summary: "edited app.mjs", data: { files: ["app.mjs"] } });
    await waitSignal();
    writeFileSync(join(req.cwd, "app.mjs"), "export const value = 42;\n");
    git(["add", "app.mjs"], req.cwd);
    git(["commit", "-qm", "fix value"], req.cwd);
    emit({ type: "thinking", summary: "committed fix" });
    return { status: "succeeded", exitCode: 0, output: "fixed" };
  });

  const h = setupHarness(adapter);
  await h.executors.probeAll();
  const repoPath = makeCodeRepo(h.home, "demo-repo", "export const value = 1;\n");

  const token = newSessionToken();
  const router = new Router();
  registerApi(router, {
    service: h.service,
    ledger: h.writer.ledger,
    bus: h.bus,
    startedAt: new Date().toISOString(),
    t3Configured: false,
    executors: h.executors,
    runStreams: h.runStreams,
    steer: (taskId, msg) => h.runner.steerTask(taskId, msg),
  });
  const server = await startListener({ router, target: { host: "127.0.0.1", port: 0 }, token });

  try {
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    // Preflight health exposes probed executors.
    const healthRes = await fetch(`${base}/api/health`, { headers });
    const health = (await healthRes.json()) as { executors: ExecutorDescriptor[] };
    assert.equal(health.executors.length, 1);
    assert.equal(health.executors[0]!.id, "mock-cli");
    assert.equal(health.executors[0]!.available, true);

    // Create repo delivery task.
    const created = h.service.createTask({
      requestId: "s3-live-1",
      kind: "repo_delivery",
      requestText: "Fix value to 42",
      executorId: "mock-cli",
      repos: [{ sourcePath: repoPath, baseRef: "main", name: "demo-repo" }],
      verificationPlan: {
        version: "check-v1",
        steps: [{ type: "command_check", name: "node-check", command: "node check.mjs", repo: "demo-repo" }],
      },
    });

    const runPromise = h.runner.runOnce();
    // Wait until live run is active.
    for (let i = 0; i < 40 && !h.runner.activeRunFor(created.taskId); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const active = h.runner.activeRunFor(created.taskId);
    assert.ok(active, "expected active live run");

    // While running (after tool_call, patch, and steer), inbox MUST remain empty!
    assert.equal(h.service.listInbox().length, 0);

    // Send steering instruction over HTTP API; releases scripted adapter.
    const steerRes = await fetch(`${base}/api/tasks/${created.taskId}/steer`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "make sure value is 42" }),
    });
    assert.equal(steerRes.status, 200);
    const steerBody = (await steerRes.json()) as { accepted: boolean; runId: string };
    assert.equal(steerBody.accepted, true);
    assert.equal(steerBody.runId, active.runId);

    await runPromise;

    const detail = h.service.getTask(created.taskId);
    assert.equal(detail.status, "completed");

    // Live stream NDJSON has tool_call, patch, steer, thinking.
    const streamRes = await fetch(`${base}/api/tasks/${created.taskId}/runs/${active.runId}/stream?format=json`, { headers });
    const streamBody = (await streamRes.json()) as { events: RunStreamEvent[] };
    assert.ok(streamBody.events.some((e) => e.type === "tool_call"));
    assert.ok(streamBody.events.some((e) => e.type === "patch"));
    assert.ok(streamBody.events.some((e) => e.summary.includes("[steer accepted]")));

    // Live SSE replay also delivers `event: run_event` frames from the NDJSON store.
    const ac = new AbortController();
    const sseRes = await fetch(`${base}/api/tasks/${created.taskId}/runs/${active.runId}/stream?afterSeq=0`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: ac.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body!.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    assert.match(firstChunk, /event: run_event/);

    // Watchdog evidence was updated by live stream events.
    assert.ok(h.store.getEvidence<string>(created.taskId, "lastActivityAt"));
    assert.deepEqual(h.store.getEvidence<string[]>(created.taskId, "changedFiles"), ["app.mjs"]);

    // Strict channel isolation: ZERO live telemetry in task_events; completed
    // delivery does not leave an actionable todo in Inbox.
    const ledgerEvents = h.writer.ledger.forTask(created.taskId, 0, 500);
    assert.equal(
      ledgerEvents.some((e) => ["tool_call", "thinking", "patch"].includes(e.type)),
      false,
    );
    const inboxItems = h.service.listInbox();
    assert.equal(inboxItems.length, 0);
  } finally {
    await server.close();
    await h.dispose();
  }
});

test("Step 3.2 negative: requesting an unavailable executor fails explicitly without falling back", async () => {
  const broken = new ScriptedAdapter("broken-cli", async () => undefined, false);
  const healthy = new ScriptedAdapter("healthy-cli", async () => undefined, true);
  const h = setupHarness(broken, [healthy]);
  await h.executors.probeAll();
  const repoPath = makeCodeRepo(h.home, "repo-unavail", "export const value = 1;\n");

  try {
    const created = h.service.createTask({
      requestId: "s3-unavail",
      kind: "repo_delivery",
      requestText: "Should refuse unavailable executor",
      executorId: "broken-cli",
      repos: [{ sourcePath: repoPath, baseRef: "main" }],
    });
    await h.runner.runOnce();
    const task = h.service.getTask(created.taskId);
    assert.equal(task.status, "failed");
    assert.match(task.failureReason ?? "", /broken-cli is unavailable/);
    assert.equal(healthy.calls, 0, "must never silently fall back to another executor");
  } finally {
    await h.dispose();
  }
});

test("Step 3.3 negative: failing command_check rejects candidate even if agent claims done and drops fake dirty file", async () => {
  const liar = new ScriptedAdapter("liar-cli", async (req) => {
    // Leaves broken code committed, drops untracked fake pass file in dirty worktree, and claims success!
    writeFileSync(join(req.cwd, "app.mjs"), "export const value = 999;\n");
    git(["add", "app.mjs"], req.cwd);
    git(["commit", "-qm", "broken commit"], req.cwd);
    writeFileSync(join(req.cwd, "TESTS_PASSED.txt"), "all tests passed!\n");
    return { status: "succeeded", exitCode: 0, output: "已修复，全部单测通过" };
  });

  const h = setupHarness(liar);
  await h.executors.probeAll();
  const repoPath = makeCodeRepo(h.home, "repo-liar", "export const value = 1;\n");

  try {
    const created = h.service.createTask({
      requestId: "s3-liar",
      kind: "repo_delivery",
      requestText: "Fix value to 42",
      executorId: "liar-cli",
      maxRepairRounds: 0,
      repos: [{ sourcePath: repoPath, baseRef: "main", name: "repo-liar" }],
      verificationPlan: {
        version: "check-v1",
        steps: [{ type: "command_check", name: "unit-test", command: "node check.mjs", repo: "repo-liar" }],
      },
    });
    await h.runner.runOnce();
    const task = h.service.getTask(created.taskId);
    assert.equal(task.status, "failed");
    assert.equal(task.verification?.result, "rejected");
    assert.match(task.failureReason ?? "", /Expected value=42, got 999/);
  } finally {
    await h.dispose();
  }
});

test("Step 3.3: bounded auto-repair feeds failure output back and stops at maxRepairRounds", async () => {
  const prompts: string[] = [];
  const fixingAdapter = new ScriptedAdapter("repair-cli", async (req, _emit, callIndex) => {
    prompts.push(req.prompt);
    // Fail round 1, fix on round 2.
    const nextVal = callIndex === 1 ? 13 : 42;
    writeFileSync(join(req.cwd, "app.mjs"), `export const value = ${nextVal};\n`);
    git(["add", "app.mjs"], req.cwd);
    git(["commit", "-qm", `attempt ${callIndex}`], req.cwd);
    return { status: "succeeded", exitCode: 0, output: `attempt ${callIndex}` };
  });

  const h = setupHarness(fixingAdapter);
  await h.executors.probeAll();
  const repoPath = makeCodeRepo(h.home, "repo-repair", "export const value = 1;\n");

  try {
    const created = h.service.createTask({
      requestId: "s3-repair-ok",
      kind: "repo_delivery",
      requestText: "Fix value to 42",
      executorId: "repair-cli",
      maxRepairRounds: 2,
      repos: [{ sourcePath: repoPath, baseRef: "main", name: "repo-repair" }],
      verificationPlan: {
        version: "check-v1",
        steps: [{ type: "command_check", name: "unit-test", command: "node check.mjs", repo: "repo-repair" }],
      },
    });
    await h.runner.runOnce();
    assert.equal(fixingAdapter.calls, 2);
    assert.match(prompts[1] ?? "", /Expected value=42, got 13/);
    const task = h.service.getTask(created.taskId);
    assert.equal(task.status, "completed");
    assert.equal(task.verification?.result, "accepted");
  } finally {
    await h.dispose();
  }

  // Now verify ceiling: always-failing adapter stops at 1 + maxRepairRounds (3 total) and never loops.
  const stuckAdapter = new ScriptedAdapter("stuck-cli", async (req, _emit, callIndex) => {
    writeFileSync(join(req.cwd, "app.mjs"), `export const value = ${callIndex};\n`);
    git(["add", "app.mjs"], req.cwd);
    git(["commit", "-qm", `still broken ${callIndex}`], req.cwd);
    return { status: "succeeded", exitCode: 0, output: "tried" };
  });
  const h2 = setupHarness(stuckAdapter);
  await h2.executors.probeAll();
  const repo2 = makeCodeRepo(h2.home, "repo-stuck", "export const value = 0;\n");
  try {
    const created2 = h2.service.createTask({
      requestId: "s3-repair-cap",
      kind: "repo_delivery",
      requestText: "Fix value to 42",
      executorId: "stuck-cli",
      maxRepairRounds: 2,
      repos: [{ sourcePath: repo2, baseRef: "main", name: "repo-stuck" }],
      verificationPlan: {
        version: "check-v1",
        steps: [{ type: "command_check", name: "unit-test", command: "node check.mjs", repo: "repo-stuck" }],
      },
    });
    await h2.runner.runOnce();
    assert.equal(stuckAdapter.calls, 3, "must run initial attempt + 2 repair rounds then stop");
    const task2 = h2.service.getTask(created2.taskId);
    assert.equal(task2.status, "failed");
  } finally {
    await h2.dispose();
  }
});

test("Step 3.3 negative: modifying candidate SHA marks prior verification stale and blocks completion", async () => {
  const adapter = new ScriptedAdapter("noop", async () => undefined);
  const h = setupHarness(adapter);
  const repoPath = makeCodeRepo(h.home, "repo-stale", "export const value = 42;\n");

  try {
    const sha1 = git(["rev-parse", "HEAD"], repoPath);
    const created = h.service.createTask({
      requestId: "s3-stale",
      kind: "repo_delivery",
      requestText: "Verify stale invalidation",
      executorId: "noop",
      repos: [{ sourcePath: repoPath, baseRef: "main", name: "repo-stale" }],
      verificationPlan: {
        version: "check-v1",
        steps: [{ type: "command_check", name: "unit-test", command: "node check.mjs", repo: "repo-stale" }],
      },
    });

    h.service.updateRepoStates(created.taskId, [{ name: "repo-stale", sourcePath: repoPath, baseRef: "main", baseSha: sha1, headSha: sha1 }]);
    const outcome1 = await h.service.verifiers.run(
      { version: "check-v1", steps: [{ type: "command_check", name: "unit-test", command: "node check.mjs", repo: "repo-stale" }] },
      {
        taskId: created.taskId,
        briefVersion: 1,
        repos: [{ name: "repo-stale", sourcePath: repoPath, baseRef: "main", baseSha: sha1, headSha: sha1 }],
        workspaces: h.workspaces,
      },
    );
    assert.equal(outcome1.status, "accepted");

    // Record verification for sha1 (without completing yet via a non-final record, or complete then check stale on new SHA).
    const digest1 = computeRepoCandidateDigest([{ name: "repo-stale", headSha: sha1 }]);
    h.store.recordCandidate({
      taskId: created.taskId,
      taskRunId: "r1",
      briefVersion: 1,
      candidate: { boundCommits: { "repo-stale": sha1 } },
      candidateDigest: digest1,
      verification: { result: "accepted", verifierVersion: "check-v1", findings: [], environment: "isolated" },
      now: new Date().toISOString(),
    });
    assert.equal(h.service.hasFreshAcceptedVerification(created.taskId, digest1), true);

    // New commit produces sha2 -> prior verification for sha1 is automatically invalidated as stale.
    writeFileSync(join(repoPath, "note.txt"), "new commit\n");
    git(["add", "note.txt"], repoPath);
    git(["commit", "-qm", "second commit"], repoPath);
    const sha2 = git(["rev-parse", "HEAD"], repoPath);
    assert.notEqual(sha2, sha1);

    const updated = h.service.updateRepoStates(created.taskId, [
      { name: "repo-stale", sourcePath: repoPath, baseRef: "main", baseSha: sha1, headSha: sha2 },
    ]);
    assert.equal(updated.invalidated, 1);
    const digest2 = computeRepoCandidateDigest([{ name: "repo-stale", headSha: sha2 }]);
    assert.equal(h.service.hasFreshAcceptedVerification(created.taskId, digest2), false);
    assert.equal(h.service.hasFreshAcceptedVerification(created.taskId, digest1), false);

    // Attempting to complete the task with the stale sha1 verification outcome is rejected!
    const verdict = h.service.recordPipelineVerification(created.taskId, "r-stale", outcome1, { finalFailure: true });
    assert.equal(verdict.status, "rejected");
    assert.ok(verdict.findings.some((f) => f.code === "stale_candidate"));
    assert.equal(h.service.getTask(created.taskId).status, "failed");
  } finally {
    await h.dispose();
  }
});

test("Step 3.2/4.1: buildIsolatedWorkerEnv strips business secrets before spawning workers", () => {
  const clean = buildIsolatedWorkerEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    GH_TOKEN: "ghp_secret",
    GITHUB_TOKEN: "ghp_secret2",
    A1_TOKEN: "aone_secret",
    TIMO_SESSION_TOKEN: "sess_secret",
    PROD_DB_URL: "postgres://prod",
    CUSTOM_ACCESS_TOKEN: "tok_secret",
    SAFE_FLAG: "1",
  });
  assert.equal(clean.PATH, "/usr/bin");
  assert.equal(clean.SAFE_FLAG, "1");
  assert.equal(clean.GH_TOKEN, undefined);
  assert.equal(clean.GITHUB_TOKEN, undefined);
  assert.equal(clean.A1_TOKEN, undefined);
  assert.equal(clean.TIMO_SESSION_TOKEN, undefined);
  assert.equal(clean.PROD_DB_URL, undefined);
  assert.equal(clean.CUSTOM_ACCESS_TOKEN, undefined);
});
