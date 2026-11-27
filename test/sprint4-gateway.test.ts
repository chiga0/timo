import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defaultConfig } from "../src/config.js";
import { TaskService } from "../src/service/task-service.js";
import { TaskStore } from "../src/store/tasks.js";
import { CapabilityMcpGateway } from "../src/gateway/mcp-gateway.js";
import { registerPlatformTools } from "../src/gateway/tools.js";
import { FakePlatformAdapter } from "../src/platform/adapter.js";
import { PiAdapter } from "../src/adapters/pi.js";

async function connectMcp(url: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "timo-test-worker", version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    },
  };
}

function parseToolText(result: unknown): Record<string, unknown> {
  const arr = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(arr[0]?.text ?? "{}") as Record<string, unknown>;
}

test("Step 4.1 (S06): Tool Visibility Pruning hides ungranted deploy_prod and direct call is rejected", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-gw-"));
  const config = defaultConfig({}, home);
  const { service, db } = TaskService.open(config);
  const store = new TaskStore(db);
  const platform = new FakePlatformAdapter();
  const gateway = new CapabilityMcpGateway({ service, credentials: { GH_TOKEN: "ghp_super_secret_token_value" } });
  registerPlatformTools(gateway, { store, service, platform });
  await gateway.start();

  try {
    const created = service.createTask({
      requestId: "gw-prune-1",
      log: new TextEncoder().encode("2026-11-26T00:00:00Z conn=c1 event=connected\n"),
    });
    const issued = gateway.issueToken(created.taskId, 1);
    const mcp = await connectMcp(issued.url);
    try {
      const listed = await mcp.client.listTools();
      const names = listed.tools.map((t) => t.name);
      // Tier 0 staging log read and timo_request_grant are visible.
      assert.ok(names.includes("timo_request_grant"));
      assert.ok(names.includes("timo_read_logs"));
      // Forbidden deploy_prod and ungranted open_pull_request are PRUNED from tools/list.
      assert.equal(names.includes("timo_deploy_prod"), false);
      assert.equal(names.includes("timo_create_or_update_mr"), false);

      // Direct call to ungranted deploy_prod is still explicitly rejected.
      const direct = await mcp.client.callTool({ name: "timo_deploy_prod", arguments: { releaseId: "r-1" } });
      assert.equal(direct.isError, true);
      const body = parseToolText(direct);
      assert.equal(body.code, "PERMISSION_DENIED");
    } finally {
      await mcp.close();
    }
  } finally {
    await gateway.close();
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Step 4.1 (S06): Tier 1 auto-grant silently widens tools/list; Tier 2 pauses in place and resumes on approval", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-gw-grant-"));
  const config = defaultConfig({}, home);
  const { service, db } = TaskService.open(config);
  const store = new TaskStore(db);
  const platform = new FakePlatformAdapter();
  platform.seedLogs("staging", ["staging ok token=secret123"]);
  platform.seedLogs("prod", ["prod error ghp_1234567890abcdef"]);

  const gateway = new CapabilityMcpGateway({ service });
  registerPlatformTools(gateway, { store, service, platform });
  await gateway.start();

  try {
    const created = service.createTask({
      requestId: "gw-grant-1",
      log: new TextEncoder().encode("2026-11-26T00:00:00Z conn=c1 event=connected\n"),
    });
    const issued = gateway.issueToken(created.taskId, 1);
    const mcp = await connectMcp(issued.url);

    try {
      // 1. Tier 1 request: open_pull_request in dev -> silent auto-grant, ZERO inbox cards.
      const t1 = await mcp.client.callTool({
        name: "timo_request_grant",
        arguments: { action: "open_pull_request", environment: "dev", resource: "repo-a" },
      });
      assert.notEqual(t1.isError, true);
      const t1Data = parseToolText(t1);
      assert.equal(t1Data.decision, "auto_grant");
      assert.equal(t1Data.tier, 1);
      assert.equal(service.listInbox().length, 0, "Tier 1 auto-grant must not disturb user inbox");

      // Next tools/list immediately includes timo_create_or_update_mr!
      const afterT1 = await mcp.client.listTools();
      assert.ok(afterT1.tools.some((t) => t.name === "timo_create_or_update_mr"));

      // 2. Trying to read prod logs before Tier 2 grant is denied.
      const deniedProd = await mcp.client.callTool({
        name: "timo_read_logs",
        arguments: { environment: "prod" },
      });
      assert.equal(deniedProd.isError, true);
      assert.equal(parseToolText(deniedProd).code, "PERMISSION_DENIED");

      // 3. Tier 2 request: read_prod_logs -> pauses in place (waiting/needs_human_decision), 1 inbox card.
      const t2 = await mcp.client.callTool({
        name: "timo_request_grant",
        arguments: { action: "read_prod_logs", environment: "prod" },
      });
      const t2Data = parseToolText(t2);
      assert.equal(t2Data.decision, "needs_human");
      assert.equal(t2Data.paused, true);
      const waiting = service.getTask(created.taskId);
      assert.equal(waiting.status, "waiting");
      assert.equal(waiting.waitingReason, "needs_human_decision");
      assert.equal(service.listInbox().length, 1);

      // 4. Human approves -> task resumes in place (same generation, no reset) and prod log read works with redaction!
      service.resolveAuthorization(created.taskId, { action: "read_prod_logs", approved: true });
      const resumed = service.getTask(created.taskId);
      assert.equal(resumed.status, "waiting");
      assert.equal(resumed.waitingReason, "retrying");

      const prodRes = await mcp.client.callTool({
        name: "timo_read_logs",
        arguments: { environment: "prod" },
      });
      assert.notEqual(prodRes.isError, true);
      const prodData = parseToolText(prodRes) as { lines: string[]; redactedCount: number };
      assert.equal(prodData.redactedCount, 1);
      assert.match(prodData.lines[0] ?? "", /\[REDACTED_GH_TOKEN\]/);
      assert.equal((prodData.lines[0] ?? "").includes("ghp_1234567890abcdef"), false);
    } finally {
      await mcp.close();
    }
  } finally {
    await gateway.close();
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Step 4.1 (S06): revoked generation Fencing Token returns HTTP 403 GENERATION_REVOKED", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-gw-fence-"));
  const config = defaultConfig({}, home);
  const { service, db } = TaskService.open(config);
  const store = new TaskStore(db);
  const platform = new FakePlatformAdapter();
  const gateway = new CapabilityMcpGateway({ service });
  registerPlatformTools(gateway, { store, service, platform });
  await gateway.start();

  try {
    const created = service.createTask({
      requestId: "gw-fence-1",
      log: new TextEncoder().encode("2026-11-26T00:00:00Z conn=c1 event=connected\n"),
    });
    const g1 = gateway.issueToken(created.taskId, 1);

    // Works while g1 is active.
    const mcp = await connectMcp(g1.url);
    const listed = await mcp.client.listTools();
    assert.ok(listed.tools.length >= 1);
    await mcp.close();

    // Stop task (revokes execution generation in DB) + revoke gateway token.
    service.stopTask(created.taskId, { reason: "test_revoke" });
    gateway.revoke(created.taskId, 1);

    // Direct HTTP call with old g1 token MUST return 403 GENERATION_REVOKED.
    const res = await fetch(g1.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "GENERATION_REVOKED");
  } finally {
    await gateway.close();
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Step 4.1 (S06): credential physical isolation — worker process environment has no business tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timo-iso-env-"));
  const prevGh = process.env.GH_TOKEN;
  const prevA1 = process.env.A1_TOKEN;
  const prevProd = process.env.PROD_API_KEY;
  process.env.GH_TOKEN = "ghp_host_secret_123456";
  process.env.A1_TOKEN = "aone_host_secret_789";
  process.env.PROD_API_KEY = "prod_host_secret_xyz";

  try {
    const cli = join(dir, "env-dump.sh");
    writeFileSync(
      cli,
      `#!/bin/sh
echo '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"GH='"$GH_TOKEN"' A1='"$A1_TOKEN"' PROD='"$PROD_API_KEY"' GW='"$TIMO_MCP_GATEWAY_URL"'"}]}}'
exit 0
`,
      { mode: 0o755 },
    );
    const adapter = new PiAdapter({ command: cli });
    const result = await adapter.spawn(
      {
        taskId: "t-iso",
        runId: "r-iso",
        cwd: dir,
        prompt: "check env",
        mcpGatewayUrl: "http://127.0.0.1:9999/mcp/t-iso/1/nonce123",
      },
      () => undefined,
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.output, "GH= A1= PROD= GW=http://127.0.0.1:9999/mcp/t-iso/1/nonce123");
  } finally {
    if (prevGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGh;
    if (prevA1 === undefined) delete process.env.A1_TOKEN;
    else process.env.A1_TOKEN = prevA1;
    if (prevProd === undefined) delete process.env.PROD_API_KEY;
    else process.env.PROD_API_KEY = prevProd;
    rmSync(dir, { recursive: true, force: true });
  }
});
