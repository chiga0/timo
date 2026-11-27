import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defaultConfig } from "../src/config.js";
import { TaskService } from "../src/service/task-service.js";
import { TaskRunner } from "../src/service/runner.js";
import { TaskStore } from "../src/store/tasks.js";
import { ArtifactStore } from "../src/store/artifacts.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { RunStreamStore } from "../src/workspace/run-stream.js";
import {
  ExecutorRegistry,
  type ExecutionAdapter,
  type ExecutorDescriptor,
  type RunStreamEvent,
  type SpawnRequest,
  type SpawnResult,
} from "../src/adapters/execution.js";
import { CapabilityMcpGateway } from "../src/gateway/mcp-gateway.js";
import { createPlatformMrVerifier, reconcileMrOperation, registerPlatformTools, resolveMrOperation } from "../src/gateway/tools.js";
import { FakePlatformAdapter } from "../src/platform/adapter.js";
import { WatchdogTriageEngine } from "../src/watchdog/triage.js";
import { Router, startListener, newSessionToken } from "../src/http/server.js";
import { registerApi } from "../src/http/routes.js";

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

function makeRepo(root: string, name: string): string {
  const dir = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: GIT_ENV });
  writeFileSync(join(dir, "app.mjs"), "export const fixed = false;\n");
  writeFileSync(
    join(dir, "check.mjs"),
    `import { fixed } from "./app.mjs";\nif (!fixed) process.exit(1);\nconsole.log("OK");\n`,
  );
  git(["add", "."], dir);
  git(["commit", "-qm", "init"], dir);
  return dir;
}

async function withMcp<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "s5-worker", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

function toolJson(result: unknown): Record<string, unknown> {
  const arr = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return JSON.parse(arr[0]?.text ?? "{}") as Record<string, unknown>;
}

class MockAdapter implements ExecutionAdapter {
  readonly prompts: string[] = [];
  readonly steered: string[] = [];
  calls = 0;

  constructor(
    readonly id: string,
    private readonly fn: (req: SpawnRequest, emit: (ev: Omit<RunStreamEvent, "seq" | "runId" | "taskId" | "at">) => void) => Promise<Partial<SpawnResult> | void>,
    private readonly supportsSteer = true,
  ) {}

  async probe(): Promise<ExecutorDescriptor> {
    return { id: this.id, kind: "cli", available: true, capabilities: { steer: this.supportsSteer, stream: true } };
  }

  async spawn(request: SpawnRequest, onEvent: (event: RunStreamEvent) => void): Promise<SpawnResult> {
    this.calls += 1;
    this.prompts.push(request.prompt);
    let seq = 0;
    const emit = (ev: Omit<RunStreamEvent, "seq" | "runId" | "taskId" | "at">) => {
      seq += 1;
      onEvent({ seq, runId: request.runId, taskId: request.taskId, at: Date.now(), ...ev });
    };
    const partial = (await this.fn(request, emit)) ?? {};
    return {
      runId: request.runId,
      externalId: partial.externalId ?? `ext-${this.id}-${this.calls}`,
      status: partial.status ?? "succeeded",
      exitCode: partial.exitCode ?? 0,
      output: partial.output ?? "ok",
    };
  }

  async resume(): Promise<SpawnResult> {
    throw new Error("not supported");
  }

  async steer(_runId: string, message: string): Promise<{ accepted: boolean; reason?: string }> {
    if (!this.supportsSteer) return { accepted: false, reason: "steer unsupported" };
    this.steered.push(message);
    return { accepted: true };
  }

  async interrupt(): Promise<{ interrupted: boolean }> {
    return { interrupted: true };
  }
}

test("Step 5.1 (S02 core negative): g1->g2 handoff blocks zombie g1 writer, revokes g1 Fencing Token, preserves budget & MR, and ignores late g1 verification", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-s5-s02-"));
  const config = defaultConfig({ TIMO_POLL_INTERVAL_MS: "20" }, home);
  const { service, db, bus, writer } = TaskService.open(config);
  const store = new TaskStore(db);
  const artifacts = ArtifactStore.create(home);
  const workspaces = new WorkspaceManager({ home: join(home, "workspaces") });
  const runStreams = new RunStreamStore(home);
  const platform = new FakePlatformAdapter();
  const gateway = new CapabilityMcpGateway({ service });
  registerPlatformTools(gateway, { store, service, platform });
  await gateway.start();

  const repoPath = makeRepo(home, "repo-be");

  // Second executor (pi) receives the Handoff Capsule in g2, sees migrated edits + untracked file, finishes commit & passes!
  const g2Adapter = new MockAdapter("pi", async (req) => {
    // Verify migrated dirty edit & untracked file from g1 are intact in g2!
    assert.match(readFileSync(join(req.cwd, "app.mjs"), "utf8"), /g1_wip/);
    assert.equal(readFileSync(join(req.cwd, "notes-from-g1.txt"), "utf8"), "untracked-wip\n");
    assert.match(req.prompt, /Handoff Capsule g1 -> g2/);
    assert.match(req.prompt, /"remainingAttempts": 4/);

    // Complete the fix in g2 and commit.
    writeFileSync(join(req.cwd, "app.mjs"), "export const fixed = true;\n");
    git(["add", "app.mjs"], req.cwd);
    git(["commit", "-qm", "g2 final fix"], req.cwd);
    return { status: "succeeded", exitCode: 0 };
  });
  const g1Adapter = new MockAdapter("qwen-code", async () => undefined);
  const executors = new ExecutorRegistry();
  executors.register(g1Adapter);
  executors.register(g2Adapter);
  await executors.probeAll();

  const runner = new TaskRunner({
    store,
    service,
    artifacts,
    writer,
    bus,
    t3: null,
    clientFactory: () => Promise.reject(new Error("unused")),
    pollIntervalMs: 20,
    waitTimeoutMs: 200,
    runDeadlineMs: 30_000,
    runStreams,
    executors,
    workspaces,
    verifiers: service.verifiers,
    mcpGateway: gateway,
    platformVerifier: createPlatformMrVerifier({ store, service, platform }),
    log: () => undefined,
  });

  try {
    const created = service.createTask({
      requestId: "s02-handoff-zombie",
      kind: "repo_delivery",
      requestText: "Fix app.mjs without deploying to prod",
      executorId: "qwen-code",
      repos: [{ sourcePath: repoPath, baseRef: "main", name: "repo-be" }],
      grants: [{ action: "open_pull_request", resource: "*", environment: "dev" }],
      verificationPlan: {
        version: "s02-v1",
        steps: [{ type: "command_check", name: "unit", command: "node check.mjs", repo: "repo-be" }],
      },
    });

    // Simulate g1 work: prepare g1 worktree, consume 1 attempt, write uncommitted edit + untracked file, create 1st MR via g1 gateway token.
    const g1Ws = workspaces.prepare(created.taskId, [{ sourcePath: repoPath, baseRef: "main", name: "repo-be" }], 1);
    const g1Dir = g1Ws.repos[0]!.worktreePath;
    const baseSha = g1Ws.repos[0]!.baseSha;
    service.updateRepoStates(created.taskId, [
      { name: "repo-be", sourcePath: repoPath, baseRef: "main", baseSha, headSha: baseSha, worktreePath: g1Dir, branch: g1Ws.repos[0]!.branch },
    ]);
    store.setEvidence(created.taskId, "attemptsUsed", 1, new Date().toISOString());

    writeFileSync(join(g1Dir, "app.mjs"), "// g1_wip\nexport const fixed = false;\n");
    writeFileSync(join(g1Dir, "notes-from-g1.txt"), "untracked-wip\n");

    const g1Token = gateway.issueToken(created.taskId, 1);
    await withMcp(g1Token.url, async (mcp) => {
      const mrRes = toolJson(
        await mcp.callTool({ name: "timo_create_or_update_mr", arguments: { repo: "repo-be", title: "WIP MR from g1", headSha: baseSha } }),
      ) as { receipt: { mrId: string } };
      assert.ok(mrRes.receipt.mrId);
    });
    assert.equal(platform.stats.mrCreated, 1);

    // Execute immutable handoff g1 (qwen-code) -> g2 (pi)!
    const handedOff = await service.handoffTask(created.taskId, {
      toExecutor: "pi",
      reason: "switch to pi",
      workspaces,
      mcpGateway: gateway,
    });
    assert.equal(handedOff.fromGeneration, 1);
    assert.equal(handedOff.toGeneration, 2);
    assert.equal(handedOff.capsule.remainingAttempts, 4, "total budget (5) minus 1 used must stay 4, never reset");
    assert.equal(handedOff.capsule.existingOperations.length, 1);

    // ZOMBIE G1 ATTACK 1: write garbage files inside g1 worktree -> g2 bytes MUST be completely isolated!
    const g2Dir = handedOff.capsule.repos[0]!.worktreePath;
    writeFileSync(join(g1Dir, "app.mjs"), "CORRUPTED_BY_ZOMBIE_G1\n");
    writeFileSync(join(g1Dir, "zombie-junk.txt"), "junk\n");
    assert.match(readFileSync(join(g2Dir, "app.mjs"), "utf8"), /g1_wip/);
    assert.equal(readFileSync(join(g2Dir, "notes-from-g1.txt"), "utf8"), "untracked-wip\n");

    // ZOMBIE G1 ATTACK 2: call Capability MCP Gateway with old g1 Fencing Token -> MUST return HTTP 403 GENERATION_REVOKED!
    const zombieRes = await fetch(g1Token.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "timo_create_or_update_mr", arguments: { repo: "repo-be", title: "zombie" } } }),
    });
    assert.equal(zombieRes.status, 403);
    assert.equal(((await zombieRes.json()) as { error: { code: string } }).error.code, "GENERATION_REVOKED");

    // ZOMBIE G1 ATTACK 3: late verification callback claiming g1 generation completed -> MUST be ignored!
    const lateVerdict = service.recordPipelineVerification(
      created.taskId,
      "g1-late-run",
      { status: "accepted", verifierVersion: "s02-v1", candidateDigest: "fake", boundCommits: { "repo-be": baseSha }, steps: [], findings: [] },
      { expectedGeneration: 1 },
    );
    assert.equal(lateVerdict.status, "ignored_stale_generation");
    assert.notEqual(service.getTask(created.taskId).status, "completed");

    // Now run g2 on `pi`: completes cleanly using migrated workspace & capsule!
    await runner.runOnce();
    assert.equal(g2Adapter.calls, 1);
    const done = service.getTask(created.taskId);
    assert.equal(done.status, "completed");
    assert.equal(platform.stats.mrCreated, 1, "existing MR from g1 must never be duplicated");
  } finally {
    await runner.stop();
    await gateway.close();
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Step 5.2 (S08): Level-2 Watchdog triage steers on loop without Inbox spam, then escalates ONE blocked card instead of burning budget", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-s5-s08-"));
  const config = defaultConfig({}, home);
  const { service, db, writer } = TaskService.open(config);
  const store = new TaskStore(db);

  try {
    const created = service.createTask({
      requestId: "s08-triage",
      log: new TextEncoder().encode("2026-11-27T00:00:00Z conn=c1 event=connected\n"),
    });
    store.setStatus(created.taskId, "running", null, new Date().toISOString());

    const steered: string[] = [];
    const triage = new WatchdogTriageEngine({
      store,
      writer,
      maxAutoSteers: 1,
      maxAutoHandoffs: 0,
      steer: async (_taskId, msg) => {
        steered.push(msg);
        return { accepted: true, runId: "r-live" };
      },
    });

    // Signal 1 (loop): Level-2 chief-of-staff injects corrective steer; Inbox remains EMPTY (0 human interruption).
    const action1 = await triage.handleSignal({
      seq: 10,
      eventId: "e-1",
      taskId: created.taskId,
      type: "watchdog_signal",
      payload: { kind: "loop", detail: "3 consecutive failures with fingerprint ECONNREFUSED" },
      idempotencyKey: "wd-1",
      createdAt: new Date().toISOString(),
    });
    assert.equal(action1.decision, "steered");
    assert.equal(steered.length, 1);
    assert.equal(service.listInbox().length, 0, "auto-steer must keep user Inbox quiet");

    // Signal 2 (loop persists after steer budget spent): escalates ONE structured blocked help card and parks task!
    const action2 = await triage.handleSignal({
      seq: 11,
      eventId: "e-2",
      taskId: created.taskId,
      type: "watchdog_signal",
      payload: { kind: "loop", detail: "3 consecutive failures with fingerprint ECONNREFUSED" },
      idempotencyKey: "wd-2",
      createdAt: new Date().toISOString(),
    });
    assert.equal(action2.decision, "escalated_blocked");
    const task = service.getTask(created.taskId);
    assert.equal(task.status, "waiting");
    assert.equal(task.waitingReason, "needs_human_decision");
    const inbox = service.listInbox();
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.decisionKey, "decision_required");
    assert.match(inbox[0]!.summary, /自动会诊无法收敛/);
  } finally {
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Step 5.2 (S04): unconfirmable effect_unknown stays blocked across restart until operator resolves via HTTP API", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-s5-s04-"));
  const config = defaultConfig({}, home);
  const repoPath = makeRepo(home, "repo-be");
  const sha = git(["rev-parse", "HEAD"], repoPath);
  const platform = new FakePlatformAdapter();
  platform.faults.dropAckWithoutCreateForRepo.add("repo-be");

  let taskId = "";
  let opId = "";

  // Process 1: ACK drops without platform creating MR -> enters effect_unknown.
  {
    const { service, db } = TaskService.open(config);
    const store = new TaskStore(db);
    const gateway = new CapabilityMcpGateway({ service });
    registerPlatformTools(gateway, { store, service, platform });
    await gateway.start();

    const created = service.createTask({
      requestId: "s04-unconfirmable",
      kind: "repo_delivery",
      requestText: "Test unconfirmable effect_unknown",
      executorId: "qwen-code",
      repos: [{ sourcePath: repoPath, baseRef: "main", name: "repo-be" }],
      grants: [{ action: "open_pull_request", resource: "*", environment: "dev" }],
    });
    taskId = created.taskId;
    service.updateRepoStates(taskId, [{ name: "repo-be", sourcePath: repoPath, baseRef: "main", baseSha: sha, headSha: sha }]);

    const url = gateway.issueUrl(taskId, 1);
    await withMcp(url, async (mcp) => {
      const res = await mcp.callTool({ name: "timo_create_or_update_mr", arguments: { repo: "repo-be", title: "MR", headSha: sha } });
      assert.equal(res.isError, true);
      const data = toolJson(res);
      assert.equal(data.code, "EFFECT_UNKNOWN");
      opId = String(data.operationId);
    });

    await gateway.close();
    service.close();
  }

  // Process 2 (simulated restart on same SQLite): reconcile finds nothing -> stays unknown -> operator resolves via POST /api/operations/:opId/resolve.
  {
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
      reconcileOperation: (id) => reconcileMrOperation(id, { store, service, platform }),
      resolveOperation: (id, input) => resolveMrOperation(id, input, { store, service }),
    });
    const server = await startListener({ router, target: { host: "127.0.0.1", port: 0 }, token });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

      // Reconcile: platform has no record -> MUST stay unknown, never auto-resend!
      const recRes = await fetch(`${base}/api/operations/${encodeURIComponent(opId)}/reconcile`, { method: "POST", headers });
      const recBody = (await recRes.json()) as { reconciled: boolean; status: string };
      assert.equal(recBody.reconciled, false);
      assert.equal(recBody.status, "unknown");
      assert.equal(platform.stats.mrCreated, 0);

      // Human operator confirms absent -> operation moves to `failed` allowing explicit fresh retry.
      const resolveRes = await fetch(`${base}/api/operations/${encodeURIComponent(opId)}/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ resolution: "confirmed_absent", reason: "checked repo, no PR exists" }),
      });
      assert.equal(resolveRes.status, 200);
      const resolved = (await resolveRes.json()) as { status: string };
      assert.equal(resolved.status, "failed");
    } finally {
      await server.close();
      service.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("Step 5.2 (S03): multi-task Amendment Diff proposal isolates tasks and refuses stale version after confirmation", () => {
  const home = mkdtempSync(join(tmpdir(), "timo-s5-s03-"));
  const config = defaultConfig({}, home);
  const { service } = TaskService.open(config);

  try {
    const taskA = service.createTask({ requestId: "s03-a", log: new TextEncoder().encode("2026-11-27T00:00:00Z conn=a event=connected\n") });
    const taskB = service.createTask({ requestId: "s03-b", log: new TextEncoder().encode("2026-11-27T00:00:00Z conn=b event=connected\n") });

    const briefA = service.getBrief(taskA.taskId);
    const briefB = service.getBrief(taskB.taskId);

    // Two proposals drafted against task A v1 (simulating concurrent race).
    const p1 = service.proposeChange(taskA.taskId, {
      change: {
        kind: "brief",
        brief: { ...briefA, goal: "仅保留后端 MR，停止前端改动" },
        diff: [{ field: "goal", before: briefA.goal, after: "仅保留后端 MR，停止前端改动" }],
      },
      reason: "用户改口",
    });
    const p2 = service.proposeChange(taskA.taskId, {
      change: {
        kind: "brief",
        brief: { ...briefA, goal: "过期改口" },
        diff: [{ field: "goal", before: briefA.goal, after: "过期改口" }],
      },
      reason: "旧版本改口",
    });

    // Before confirm, NEITHER task A nor task B is mutated.
    assert.equal(service.getTask(taskA.taskId).briefVersion, 1);
    assert.equal(service.getTask(taskB.taskId).briefVersion, 1);

    // Confirm p1 -> task A moves to v2; task B stays completely isolated at v1!
    const confirmed = service.confirmProposal(p1.proposalId);
    assert.equal(confirmed.briefVersion, 2);
    assert.equal(service.getBrief(taskA.taskId).goal, "仅保留后端 MR，停止前端改动");
    assert.equal(service.getBrief(taskB.taskId).goal, briefB.goal);
    assert.equal(service.getTask(taskB.taskId).briefVersion, 1);

    // Confirming stale p2 drafted on v1 MUST fail with ProposalConflictError!
    assert.throws(() => service.confirmProposal(p2.proposalId), /older revision/);
  } finally {
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
});
