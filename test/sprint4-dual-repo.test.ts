import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { createPlatformMrVerifier, reconcileMrOperation, registerPlatformTools } from "../src/gateway/tools.js";
import { FakePlatformAdapter } from "../src/platform/adapter.js";
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

function makeDualRepos(root: string): { repoBe: string; repoFe: string } {
  const repoBe = join(root, "repo-be");
  execFileSync("git", ["init", "-q", "-b", "main", repoBe], { env: GIT_ENV });
  writeFileSync(join(repoBe, "protocol.json"), JSON.stringify({ event: "disconnect", retryMs: 0 }) + "\n");
  git(["add", "."], repoBe);
  git(["commit", "-qm", "be init"], repoBe);

  const repoFe = join(root, "repo-fe");
  execFileSync("git", ["init", "-q", "-b", "main", repoFe], { env: GIT_ENV });
  writeFileSync(join(repoFe, "client.json"), JSON.stringify({ expectedEvent: "reconnect", reconnect: false }) + "\n");
  git(["add", "."], repoFe);
  git(["commit", "-qm", "fe init"], repoFe);

  return { repoBe, repoFe };
}

/** Combo verification script executed inside the isolated clean multi-repo root. */
const COMBO_CHECK_CMD = `node -e '
const fs = require("fs");
const be = JSON.parse(fs.readFileSync("repo-be/protocol.json", "utf8"));
const fe = JSON.parse(fs.readFileSync("repo-fe/client.json", "utf8"));
if (be.event !== fe.expectedEvent || be.retryMs <= 0 || fe.reconnect !== true) {
  console.error("COMBO_MISMATCH", { be, fe });
  process.exit(1);
}
console.log("COMBO_RECONNECT_OK");
'`;

async function withMcp<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "dual-repo-worker", version: "0.1.0" });
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

class DualRepoAdapter implements ExecutionAdapter {
  readonly id = "dual-worker";
  spawnCount = 0;

  constructor(private readonly work: (req: SpawnRequest) => Promise<void>) {}

  async probe(): Promise<ExecutorDescriptor> {
    return { id: this.id, kind: "cli", available: true, capabilities: { stream: true } };
  }

  async spawn(request: SpawnRequest, onEvent: (event: RunStreamEvent) => void): Promise<SpawnResult> {
    this.spawnCount += 1;
    onEvent({ seq: 1, runId: request.runId, taskId: request.taskId, type: "status", at: Date.now(), summary: "starting dual-repo fix" });
    await this.work(request);
    onEvent({ seq: 2, runId: request.runId, taskId: request.taskId, type: "status", at: Date.now(), summary: "finished dual-repo fix" });
    return { runId: request.runId, externalId: `ext-${request.runId}`, status: "succeeded", exitCode: 0, output: "done" };
  }

  async resume(): Promise<SpawnResult> {
    throw new Error("not supported");
  }

  async steer(): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }

  async interrupt(): Promise<{ interrupted: boolean }> {
    return { interrupted: true };
  }
}

async function setupDualHarness(workerFn: (req: SpawnRequest, platform: FakePlatformAdapter) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "timo-s4-"));
  const config = defaultConfig({ TIMO_POLL_INTERVAL_MS: "20" }, home);
  const { service, db, bus, writer } = TaskService.open(config);
  const store = new TaskStore(db);
  const artifacts = ArtifactStore.create(home);
  const workspaces = new WorkspaceManager({ home: join(home, "workspaces") });
  const runStreams = new RunStreamStore(home);
  const platform = new FakePlatformAdapter();
  platform.seedLogs("staging", [
    "2026-11-26T10:00:00Z conn=c1 event=disconnected Authorization: Bearer secret_abc_123456",
    "2026-11-26T10:00:01Z conn=c1 event=missing_reconnect",
  ]);

  const gateway = new CapabilityMcpGateway({ service, credentials: { GH_TOKEN: "ghp_gateway_only" } });
  registerPlatformTools(gateway, { store, service, platform });
  await gateway.start();

  const adapter = new DualRepoAdapter((req) => workerFn(req, platform));
  const executors = new ExecutorRegistry();
  executors.register(adapter);
  await executors.probeAll();

  const runner = new TaskRunner({
    store,
    service,
    artifacts,
    writer,
    bus,
    t3: null,
    clientFactory: () => Promise.reject(new Error("t3 unused")),
    pollIntervalMs: 20,
    waitTimeoutMs: 200,
    runDeadlineMs: 30_000,
    ciPollIntervalMs: 10,
    runStreams,
    executors,
    workspaces,
    verifiers: service.verifiers,
    mcpGateway: gateway,
    platformVerifier: createPlatformMrVerifier({ store, service, platform }),
    log: () => undefined,
  });

  const repos = makeDualRepos(home);

  return {
    home,
    service,
    store,
    bus,
    writer,
    workspaces,
    platform,
    gateway,
    adapter,
    runner,
    ...repos,
    dispose: async () => {
      await runner.stop();
      await gateway.close();
      service.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("Step 4.2 (S01): dual-repo fix -> 2 MRs -> 0-Token CI polling -> combo verification -> completed without deploy", async () => {
  let beMrId = "";
  let feMrId = "";
  let beSha = "";
  let feSha = "";

  const h = await setupDualHarness(async (req) => {
    assert.ok(req.mcpGatewayUrl, "gateway URL must be injected");
    const beDir = join(req.cwd, "repo-be");
    const feDir = join(req.cwd, "repo-fe");

    await withMcp(req.mcpGatewayUrl!, async (mcp) => {
      // 1. Read staging logs via gateway and verify secret redaction.
      const logsRes = await mcp.callTool({ name: "timo_read_logs", arguments: { environment: "staging" } });
      const logs = toolJson(logsRes) as { lines: string[]; redactedCount: number };
      assert.equal(logs.redactedCount, 1);
      assert.equal(logs.lines[0]!.includes("secret_abc_123456"), false);

      // 2. Verify deploy_prod is NOT exposed.
      const tools = await mcp.listTools();
      assert.equal(tools.tools.some((t) => t.name === "timo_deploy_prod"), false);

      // 3. Request Tier 1 open_pull_request silently.
      const grant = toolJson(
        await mcp.callTool({ name: "timo_request_grant", arguments: { action: "open_pull_request", environment: "dev" } }),
      );
      assert.equal(grant.decision, "auto_grant");

      // 4. Commit compatible fixes in both worktrees.
      writeFileSync(join(beDir, "protocol.json"), JSON.stringify({ event: "reconnect", retryMs: 500 }) + "\n");
      git(["add", "."], beDir);
      git(["commit", "-qm", "be reconnect fix"], beDir);
      beSha = git(["rev-parse", "HEAD"], beDir);

      writeFileSync(join(feDir, "client.json"), JSON.stringify({ expectedEvent: "reconnect", reconnect: true }) + "\n");
      git(["add", "."], feDir);
      git(["commit", "-qm", "fe reconnect fix"], feDir);
      feSha = git(["rev-parse", "HEAD"], feDir);

      // 5. Submit both MRs via Intent-Before-Effect gateway tool.
      const mrBe = toolJson(
        await mcp.callTool({ name: "timo_create_or_update_mr", arguments: { repo: "repo-be", title: "Fix BE SSE reconnect", headSha: beSha } }),
      ) as { receipt: { mrId: string } };
      const mrFe = toolJson(
        await mcp.callTool({ name: "timo_create_or_update_mr", arguments: { repo: "repo-fe", title: "Fix FE SSE reconnect", headSha: feSha } }),
      ) as { receipt: { mrId: string } };
      beMrId = mrBe.receipt.mrId;
      feMrId = mrFe.receipt.mrId;
    });
  });

  try {
    const created = h.service.createTask({
      requestId: "s01-dual-happy",
      kind: "repo_delivery",
      requestText: "Fix BE+FE SSE reconnect, submit 2 MRs, wait for CI, do not deploy",
      executorId: "dual-worker",
      maxRepairRounds: 0,
      repos: [
        { sourcePath: h.repoBe, baseRef: "main", name: "repo-be" },
        { sourcePath: h.repoFe, baseRef: "main", name: "repo-fe" },
      ],
      verificationPlan: {
        version: "s01-v1",
        steps: [
          { type: "platform_mr", name: "ci-be", repo: "repo-be" },
          { type: "platform_mr", name: "ci-fe", repo: "repo-fe" },
          { type: "command_check", name: "combo-reconnect", command: COMBO_CHECK_CMD, combo: true },
        ],
      },
    });

    // Pass 1: Worker runs once, creates 2 MRs, CI is pending -> enters waiting_external_ci.
    await h.runner.runOnce();
    assert.equal(h.adapter.spawnCount, 1);
    const waiting = h.service.getTask(created.taskId);
    assert.equal(waiting.status, "waiting");
    assert.equal(waiting.waitingReason, "waiting_external_ci");
    assert.equal(h.platform.stats.mrCreated, 2);

    // Wait past ciPollIntervalMs while CI is STILL pending -> 0-Token poll runs, 0 new model calls!
    await new Promise((r) => setTimeout(r, 25));
    await h.runner.runOnce();
    assert.equal(h.adapter.spawnCount, 1, "waiting for CI must consume ZERO model calls");
    assert.equal(h.service.getTask(created.taskId).status, "waiting");

    // Both CIs turn green on the exact latest candidate SHAs.
    h.platform.setCiStatus("repo-be", beMrId, { headSha: beSha, status: "passed", checks: [{ name: "be-test", status: "passed" }] });
    h.platform.setCiStatus("repo-fe", feMrId, { headSha: feSha, status: "passed", checks: [{ name: "fe-test", status: "passed" }] });

    await new Promise((r) => setTimeout(r, 25));
    await h.runner.runOnce();

    // Still ZERO extra model calls during CI wait & final combo verification!
    assert.equal(h.adapter.spawnCount, 1);
    const done = h.service.getTask(created.taskId);
    assert.equal(done.status, "completed");
    assert.equal((done.result as { productionDeployed?: boolean }).productionDeployed, false);
    assert.equal(done.repos?.length, 2);
    assert.ok(done.repos!.every((r) => r.ciStatus === "passed" && r.mrId));
  } finally {
    await h.dispose();
  }
});

test("Step 4.2 negative (S05): both single-repo CIs green but combo test fails -> task is rejected", async () => {
  const h = await setupDualHarness(async (req, platform) => {
    const beDir = join(req.cwd, "repo-be");
    const feDir = join(req.cwd, "repo-fe");
    await withMcp(req.mcpGatewayUrl!, async (mcp) => {
      await mcp.callTool({ name: "timo_request_grant", arguments: { action: "open_pull_request", environment: "dev" } });

      // Incompatible protocol between BE and FE!
      writeFileSync(join(beDir, "protocol.json"), JSON.stringify({ event: "v2_ping", retryMs: 500 }) + "\n");
      git(["add", "."], beDir);
      git(["commit", "-qm", "be v2_ping"], beDir);
      const beSha = git(["rev-parse", "HEAD"], beDir);

      writeFileSync(join(feDir, "client.json"), JSON.stringify({ expectedEvent: "reconnect", reconnect: true }) + "\n");
      git(["add", "."], feDir);
      git(["commit", "-qm", "fe expects reconnect"], feDir);
      const feSha = git(["rev-parse", "HEAD"], feDir);

      const mrBe = toolJson(
        await mcp.callTool({ name: "timo_create_or_update_mr", arguments: { repo: "repo-be", title: "BE", headSha: beSha } }),
      ) as { receipt: { mrId: string } };
      const mrFe = toolJson(
        await mcp.callTool({ name: "timo_create_or_update_mr", arguments: { repo: "repo-fe", title: "FE", headSha: feSha } }),
      ) as { receipt: { mrId: string } };

      // Both single-repo CIs are GREEN on latest SHAs!
      platform.setCiStatus("repo-be", mrBe.receipt.mrId, { headSha: beSha, status: "passed", checks: [{ name: "ci", status: "passed" }] });
      platform.setCiStatus("repo-fe", mrFe.receipt.mrId, { headSha: feSha, status: "passed", checks: [{ name: "ci", status: "passed" }] });
    });
  });

  try {
    const created = h.service.createTask({
      requestId: "s05-combo-fail",
      kind: "repo_delivery",
      requestText: "Combo mismatch must be rejected",
      executorId: "dual-worker",
      maxRepairRounds: 0,
      repos: [
        { sourcePath: h.repoBe, baseRef: "main", name: "repo-be" },
        { sourcePath: h.repoFe, baseRef: "main", name: "repo-fe" },
      ],
      verificationPlan: {
        version: "s05-v1",
        steps: [
          { type: "platform_mr", name: "ci-be", repo: "repo-be" },
          { type: "platform_mr", name: "ci-fe", repo: "repo-fe" },
          { type: "command_check", name: "combo-reconnect", command: COMBO_CHECK_CMD, combo: true },
        ],
      },
    });
    await h.runner.runOnce();
    const task = h.service.getTask(created.taskId);
    assert.equal(task.status, "failed");
    assert.match(task.failureReason ?? "", /COMBO_MISMATCH/);
  } finally {
    await h.dispose();
  }
});

test("Step 4.2 negative (S05): green CI bound to older headSha is rejected as stale_ci_sha", async () => {
  const h = await setupDualHarness(async (req, platform) => {
    const beDir = join(req.cwd, "repo-be");
    const feDir = join(req.cwd, "repo-fe");
    await withMcp(req.mcpGatewayUrl!, async (mcp) => {
      await mcp.callTool({ name: "timo_request_grant", arguments: { action: "open_pull_request", environment: "dev" } });

      writeFileSync(join(beDir, "protocol.json"), JSON.stringify({ event: "reconnect", retryMs: 500 }) + "\n");
      git(["add", "."], beDir);
      git(["commit", "-qm", "be commit 1"], beDir);
      const oldBeSha = git(["rev-parse", "HEAD"], beDir);

      // Second commit on BE -> latest SHA is newBeSha, while CI green is stuck on oldBeSha!
      writeFileSync(join(beDir, "README.md"), "extra\n");
      git(["add", "."], beDir);
      git(["commit", "-qm", "be commit 2"], beDir);
      const newBeSha = git(["rev-parse", "HEAD"], beDir);

      writeFileSync(join(feDir, "client.json"), JSON.stringify({ expectedEvent: "reconnect", reconnect: true }) + "\n");
      git(["add", "."], feDir);
      git(["commit", "-qm", "fe commit"], feDir);
      const feSha = git(["rev-parse", "HEAD"], feDir);

      const mrBe = toolJson(
        await mcp.callTool({ name: "timo_create_or_update_mr", arguments: { repo: "repo-be", title: "BE", headSha: newBeSha } }),
      ) as { receipt: { mrId: string } };
      const mrFe = toolJson(
        await mcp.callTool({ name: "timo_create_or_update_mr", arguments: { repo: "repo-fe", title: "FE", headSha: feSha } }),
      ) as { receipt: { mrId: string } };

      // CI green on BE is for OLD SHA, not newBeSha!
      platform.setCiStatus("repo-be", mrBe.receipt.mrId, { headSha: oldBeSha, status: "passed", checks: [{ name: "ci", status: "passed" }] });
      platform.setCiStatus("repo-fe", mrFe.receipt.mrId, { headSha: feSha, status: "passed", checks: [{ name: "ci", status: "passed" }] });
    });
  });

  try {
    const created = h.service.createTask({
      requestId: "s05-stale-ci",
      kind: "repo_delivery",
      requestText: "Reject stale CI SHA",
      executorId: "dual-worker",
      maxRepairRounds: 0,
      repos: [
        { sourcePath: h.repoBe, baseRef: "main", name: "repo-be" },
        { sourcePath: h.repoFe, baseRef: "main", name: "repo-fe" },
      ],
      verificationPlan: {
        version: "s05-v1",
        steps: [
          { type: "platform_mr", name: "ci-be", repo: "repo-be" },
          { type: "platform_mr", name: "ci-fe", repo: "repo-fe" },
        ],
      },
    });
    await h.runner.runOnce();
    const task = h.service.getTask(created.taskId);
    assert.equal(task.status, "failed");
    assert.match(task.failureReason ?? "", /stale_ci_sha/);
    assert.equal(task.repos?.find((r) => r.name === "repo-be")?.ciStatus, "stale");
  } finally {
    await h.dispose();
  }
});

test("Step 4.2 negative: 1st MR succeeds & 2nd fails -> retry preserves 1st receipt with zero duplicate MR", async () => {
  const h = await setupDualHarness(async (req, platform) => {
    const beDir = join(req.cwd, "repo-be");
    const feDir = join(req.cwd, "repo-fe");
    platform.faults.failOnceForRepo.add("repo-fe");

    await withMcp(req.mcpGatewayUrl!, async (mcp) => {
      await mcp.callTool({ name: "timo_request_grant", arguments: { action: "open_pull_request", environment: "dev" } });

      writeFileSync(join(beDir, "protocol.json"), JSON.stringify({ event: "reconnect", retryMs: 500 }) + "\n");
      git(["add", "."], beDir);
      git(["commit", "-qm", "be"], beDir);
      const beSha = git(["rev-parse", "HEAD"], beDir);

      writeFileSync(join(feDir, "client.json"), JSON.stringify({ expectedEvent: "reconnect", reconnect: true }) + "\n");
      git(["add", "."], feDir);
      git(["commit", "-qm", "fe"], feDir);
      const feSha = git(["rev-parse", "HEAD"], feDir);

      // Attempt 1: BE succeeds, FE fails.
      const firstBe = toolJson(
        await mcp.callTool({ name: "timo_create_or_update_mr", arguments: { repo: "repo-be", title: "BE", headSha: beSha } }),
      ) as { reused: boolean; receipt: { mrId: string } };
      assert.equal(firstBe.reused, false);
      const failedFe = await mcp.callTool({ name: "timo_create_or_update_mr", arguments: { repo: "repo-fe", title: "FE", headSha: feSha } });
      assert.equal(failedFe.isError, true);
      assert.equal(platform.stats.mrCreated, 1);

      // Retry BOTH: BE MUST reuse saved receipt (zero platform call / zero duplicate!), FE now creates its MR.
      const retryBe = toolJson(
        await mcp.callTool({ name: "timo_create_or_update_mr", arguments: { repo: "repo-be", title: "BE", headSha: beSha } }),
      ) as { reused: boolean; receipt: { mrId: string } };
      assert.equal(retryBe.reused, true);
      assert.equal(retryBe.receipt.mrId, firstBe.receipt.mrId);

      const retryFe = toolJson(
        await mcp.callTool({ name: "timo_create_or_update_mr", arguments: { repo: "repo-fe", title: "FE", headSha: feSha } }),
      ) as { reused: boolean; receipt: { mrId: string } };
      assert.equal(retryFe.reused, false);
      assert.equal(platform.stats.mrCreated, 2);

      platform.setCiStatus("repo-be", retryBe.receipt.mrId, { headSha: beSha, status: "passed", checks: [{ name: "ci", status: "passed" }] });
      platform.setCiStatus("repo-fe", retryFe.receipt.mrId, { headSha: feSha, status: "passed", checks: [{ name: "ci", status: "passed" }] });
    });
  });

  try {
    const created = h.service.createTask({
      requestId: "s05-partial-mr",
      kind: "repo_delivery",
      requestText: "Partial MR retry without duplicate",
      executorId: "dual-worker",
      maxRepairRounds: 0,
      repos: [
        { sourcePath: h.repoBe, baseRef: "main", name: "repo-be" },
        { sourcePath: h.repoFe, baseRef: "main", name: "repo-fe" },
      ],
      verificationPlan: {
        version: "s05-v1",
        steps: [
          { type: "platform_mr", name: "ci-be", repo: "repo-be" },
          { type: "platform_mr", name: "ci-fe", repo: "repo-fe" },
          { type: "command_check", name: "combo", command: COMBO_CHECK_CMD, combo: true },
        ],
      },
    });
    await h.runner.runOnce();
    assert.equal(h.service.getTask(created.taskId).status, "completed");
    assert.equal(h.platform.stats.mrCreated, 2);
  } finally {
    await h.dispose();
  }
});

test("Step 4.2 negative (S04): dropped ACK enters effect_unknown, refuses blind resend, and reconciles via HTTP API", async () => {
  const h = await setupDualHarness(async () => undefined);
  const token = newSessionToken();
  const router = new Router();
  registerApi(router, {
    service: h.service,
    ledger: h.writer.ledger,
    bus: h.bus,
    startedAt: new Date().toISOString(),
    t3Configured: false,
    reconcileOperation: (opId) => reconcileMrOperation(opId, { store: h.store, service: h.service, platform: h.platform }),
  });
  const server = await startListener({ router, target: { host: "127.0.0.1", port: 0 }, token });

  try {
    const created = h.service.createTask({
      requestId: "s04-drop-ack",
      kind: "repo_delivery",
      requestText: "Test dropped ACK effect_unknown reconciliation",
      executorId: "dual-worker",
      repos: [{ sourcePath: h.repoBe, baseRef: "main", name: "repo-be" }],
      grants: [{ action: "open_pull_request", resource: "*", environment: "dev" }],
    });
    const sha = git(["rev-parse", "HEAD"], h.repoBe);
    h.service.updateRepoStates(created.taskId, [{ name: "repo-be", sourcePath: h.repoBe, baseRef: "main", baseSha: sha, headSha: sha }]);

    const url = h.gateway.issueUrl(created.taskId, 1);
    h.platform.faults.dropAckOnceForRepo.add("repo-be");

    let opId = "";
    await withMcp(url, async (mcp) => {
      // 1. Platform creates MR, then ACK drops -> operation marked unknown, task waits in effect_unknown.
      const first = await mcp.callTool({ name: "timo_create_or_update_mr", arguments: { repo: "repo-be", title: "BE", headSha: sha } });
      assert.equal(first.isError, true);
      const firstBody = toolJson(first);
      assert.equal(firstBody.code, "EFFECT_UNKNOWN");
      opId = String(firstBody.operationId);
      assert.equal(h.platform.stats.mrCreated, 1);
      assert.equal(h.service.getTask(created.taskId).waitingReason, "effect_unknown");

      // 2. Blind retry MUST be refused by gateway without touching platform!
      const callsBefore = h.platform.stats.mrCalls;
      const blind = await mcp.callTool({ name: "timo_create_or_update_mr", arguments: { repo: "repo-be", title: "BE", headSha: sha } });
      assert.equal(blind.isError, true);
      assert.equal(toolJson(blind).code, "EFFECT_UNKNOWN");
      assert.equal(h.platform.stats.mrCalls, callsBefore, "blind resend must never call platform");
    });

    // 3. Reconcile via HTTP API -> discovers existing MR on platform, binds receipt, zero duplicates!
    const recRes = await fetch(`http://127.0.0.1:${server.port}/api/operations/${encodeURIComponent(opId)}/reconcile`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(recRes.status, 200);
    const rec = (await recRes.json()) as { reconciled: boolean; status: string; receipt: { mrId: string } };
    assert.equal(rec.reconciled, true);
    assert.equal(rec.status, "done");
    assert.ok(rec.receipt.mrId);
    assert.equal(h.platform.stats.mrCreated, 1, "reconcile must recover existing MR without creating a second one");
  } finally {
    await server.close();
    await h.dispose();
  }
});
