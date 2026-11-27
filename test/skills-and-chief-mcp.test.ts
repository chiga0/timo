import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defaultConfig } from "../src/config.js";
import { TaskService } from "../src/service/task-service.js";
import { SettingsStore } from "../src/settings.js";
import { SkillRegistry, parseSlashSkillInvocation, selectActiveSkills } from "../src/skills/registry.js";
import { ChatStore, ChatStreamBus } from "../src/store/chat.js";
import { MainChatRunner } from "../src/service/chat-runner.js";
import { CapabilityMcpGateway } from "../src/gateway/mcp-gateway.js";
import { registerChiefTools } from "../src/gateway/chief-tools.js";
import { ExecutorRegistry, type ExecutionAdapter, type RunStreamEvent, type SpawnRequest, type SpawnResult } from "../src/adapters/execution.js";
import { Router } from "../src/http/server.js";
import { registerApi } from "../src/http/routes.js";
import { RunStreamStore } from "../src/workspace/run-stream.js";

async function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "timo-skills-mcp-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Timo Unified Skills, Main Chat Context Engine & Chief-of-Staff MCP", () => {
  it("manages SKILL.md lifecycle, imports external skills with secret redaction, and parses /slash invocations", async () => {
    await withTempDir((dir) => {
      const home = join(dir, "timo-home");
      const fakeUserHome = join(dir, "user-home");
      const qwenSkills = join(fakeUserHome, ".qwen", "skills", "deploy-check");
      mkdirSync(qwenSkills, { recursive: true });
      writeFileSync(
        join(qwenSkills, "SKILL.md"),
        [
          "---",
          "name: deploy-check",
          "description: 发布前检查数据库迁移与回滚预案",
          "---",
          "1. 确认迁移脚本幂等",
          "2. 禁止打印 token=sk-live-secret-9999999999",
        ].join("\n"),
        "utf8",
      );

      const registry = new SkillRegistry(home, { HOME: fakeUserHome });
      const discovered = registry.discoverExternalSources();
      assert.equal(discovered.length, 1);
      assert.equal(discovered[0]?.id, "qwen");
      assert.equal(discovered[0]?.skillCount, 1);

      // Import external skill into ~/.timo/skills with secret redaction
      const imported = registry.importFromDir(join(fakeUserHome, ".qwen", "skills"));
      assert.deepEqual(imported.imported, ["deploy-check"]);
      const full = registry.readFull("deploy-check");
      assert.ok(full);
      assert.match(full.body, /确认迁移脚本幂等/);
      assert.doesNotMatch(full.body, /sk-live-secret-9999999999/);

      // Create & update a managed skill
      const created = registry.saveManaged({
        name: "code-review",
        description: "审查代码改动并输出风险清单",
        scope: "repo:demo-app",
        content: "# 检查项\n- 检查并发安全\n- 检查边界条件",
      });
      assert.equal(created.id, "code-review");
      assert.equal(created.source, "managed");

      const all = registry.list();
      assert.equal(all.length, 2);

      // Scope filtering
      assert.deepEqual(
        selectActiveSkills(all, "chat", []).map((s) => s.id),
        ["deploy-check"],
      );
      assert.deepEqual(
        selectActiveSkills(all, "task", ["demo-app"]).map((s) => s.id),
        ["code-review", "deploy-check"],
      );

      // Explicit /slash skill invocation
      const parsed = parseSlashSkillInvocation("/code-review 帮我看看本次 PR", all);
      assert.ok(parsed);
      assert.equal(parsed.skill.id, "code-review");
      assert.equal(parsed.remainingText, "帮我看看本次 PR");

      // Delete managed skill
      assert.equal(registry.deleteManaged("code-review"), true);
      assert.equal(registry.list().length, 1);
    });
  });

  it("injects knowledge base, service catalog, unified skills, /slash body, and short-lived Chief MCP URL into Main Chat", async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const docsDir = join(dir, "docs");
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, "runbook.md"), "# 线上排查手册\n遇到 502 时先检查网关超时配置。", "utf8");

      const config = defaultConfig({}, home);
      const { service, db } = TaskService.open(config);
      const settingsStore = new SettingsStore(home, {});
      settingsStore.save({
        ...settingsStore.load(),
        folders: [{ id: "runbook", name: "runbook", path: docsDir, kind: "docs", description: "排障文档" }],
        connections: [{ id: "git-1", name: "Internal Git", kind: "enterprise_git", baseUrl: "https://git.example.com", credentialKey: "GIT_TOKEN" }],
      });
      const skillRegistry = new SkillRegistry(home, {});
      skillRegistry.saveManaged({
        name: "incident-triage",
        description: "故障三步定位法",
        content: "第一步：核对时间窗。\n第二步：检查最近发布。\n第三步：输出止血方案。",
      });

      const mcpGateway = new CapabilityMcpGateway({ service, port: 0 });
      const chatStore = new ChatStore(db);
      const chatBus = new ChatStreamBus();
      registerChiefTools(mcpGateway, { service, settingsStore, skillRegistry, chatStore, chatBus });
      await mcpGateway.start();

      const capturedRequests: SpawnRequest[] = [];
      const fakeAdapter: ExecutionAdapter = {
        id: "qwen-code",
        async probe() {
          return { id: "qwen-code", kind: "cli", available: true, capabilities: { stream: true, mcpGateway: true } };
        },
        async spawn(req: SpawnRequest, onEvent: (ev: RunStreamEvent) => void): Promise<SpawnResult> {
          capturedRequests.push(req);
          onEvent({ seq: 1, runId: req.runId, taskId: req.taskId, type: "text_delta", at: Date.now(), summary: "已收到" });
          return { runId: req.runId, externalId: "ext-chat", status: "succeeded", exitCode: 0, output: "已收到" };
        },
        async resume() {
          throw new Error("unused");
        },
        async steer() {
          return { accepted: false };
        },
        async interrupt() {
          return { interrupted: true };
        },
      };
      const registry = new ExecutorRegistry();
      registry.register(fakeAdapter);
      await registry.probeAll();

      try {
        const chatRunner = new MainChatRunner({
          home,
          chatStore,
          chatBus,
          service,
          executors: registry,
          settingsStore,
          skillRegistry,
          mcpGateway,
        });

        chatRunner.send({ text: "/incident-triage 线上出现 502", executorId: "qwen-code" });
        await new Promise((r) => setTimeout(r, 60));

        assert.equal(capturedRequests.length, 1);
        const req = capturedRequests[0]!;
        assert.match(req.prompt, /遇到 502 时先检查网关超时配置/, "knowledge docs MUST be injected into Main Chat");
        assert.match(req.prompt, /https:\/\/git\.example\.com/, "configured platform catalog MUST be injected");
        assert.match(req.prompt, /Timo 托管统一 Skill 清单/, "unified skills catalog MUST be injected");
        assert.match(req.prompt, /incident-triage/, "skill id MUST appear in catalog");
        assert.match(req.prompt, /第一步：核对时间窗/, "explicit /slash skill full body MUST be injected");
        assert.match(req.prompt, /timo_delegate_task/, "Chief-of-Staff MCP guidance MUST be injected");
        assert.ok(req.mcpGatewayUrl && req.mcpGatewayUrl.includes("/mcp/chief/"), "Chief MCP URL MUST be mounted");

        // Once the turn finishes, the short-lived Chief MCP nonce MUST be revoked!
        const afterRes = await fetch(req.mcpGatewayUrl!, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        assert.equal(afterRes.status, 403);
      } finally {
        await mcpGateway.close();
        service.close();
      }
    });
  });

  it("exposes Chief-of-Staff MCP control tools cleanly isolated from Worker tools + serves /api/skills REST endpoints", async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const repoDir = join(dir, "demo-repo");
      mkdirSync(repoDir, { recursive: true });
      writeFileSync(join(repoDir, "README.md"), "# Demo Repo\n", "utf8");
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      execFileSync("git", ["add", "README.md"], { cwd: repoDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

      const config = defaultConfig({}, home);
      const { service, db, bus, writer } = TaskService.open(config);
      const settingsStore = new SettingsStore(home, {});
      settingsStore.save({
        ...settingsStore.load(),
        folders: [{ id: "demo-repo", name: "demo-repo", path: repoDir, kind: "git", baseRef: "main" }],
      });
      const skillRegistry = new SkillRegistry(home, {});
      skillRegistry.saveManaged({
        name: "pr-summary",
        description: "生成 PR 变更摘要",
        content: "按模块汇总改动并附测试命令。",
      });
      const chatStore = new ChatStore(db);
      const chatBus = new ChatStreamBus();
      const runStreams = new RunStreamStore(home);

      const gateway = new CapabilityMcpGateway({ service, port: 0 });
      registerChiefTools(gateway, { service, settingsStore, skillRegistry, chatStore, chatBus, runStreams });
      await gateway.start();

      try {
        // 1. Connect real MCP client to /mcp/chief/:nonce
        const chief = gateway.issueChiefToken();
        const client = new McpClient({ name: "chief-test-client", version: "1.0.0" });
        const transport = new StreamableHTTPClientTransport(new URL(chief.url));
        await client.connect(transport);

        const listedTools = await client.listTools();
        const toolNames = listedTools.tools.map((t) => t.name);
        assert.ok(toolNames.includes("timo_list_skills"));
        assert.ok(toolNames.includes("timo_delegate_task"));
        assert.ok(toolNames.includes("timo_propose_task_change"));
        assert.ok(!toolNames.includes("timo_request_grant"), "Chief endpoint must NOT expose worker grant tool");

        // Call timo_list_skills & timo_read_skill
        const skillsRes = await client.callTool({ name: "timo_list_skills", arguments: {} });
        const skillsJson = JSON.parse((skillsRes.content as Array<{ text: string }>)[0]!.text) as { count: number };
        assert.equal(skillsJson.count, 1);

        // Call timo_delegate_task -> creates real task AND appends ONE task_card into Main Chat
        const delRes = await client.callTool({
          name: "timo_delegate_task",
          arguments: { requestText: "优化 demo-repo 的错误处理", repoNames: ["demo-repo"] },
        });
        const delJson = JSON.parse((delRes.content as Array<{ text: string }>)[0]!.text) as { taskId: string; status: string };
        assert.ok(delJson.taskId);
        assert.equal(chatStore.list(20).filter((m) => m.role === "task_card").length, 1);

        // Call timo_propose_task_change -> two-phase Diff proposal without mutating brief directly
        const propRes = await client.callTool({
          name: "timo_propose_task_change",
          arguments: { taskId: delJson.taskId.slice(0, 8), newGoal: "优化 demo-repo 错误处理并补充单测" },
        });
        const propJson = JSON.parse((propRes.content as Array<{ text: string }>)[0]!.text) as { proposal: { status: string } };
        assert.equal(propJson.proposal.status, "pending");
        assert.equal(service.listProposals(delJson.taskId).length, 1);

        // Worker endpoint for that task must NEVER see Chief tools
        const workerTools = gateway.visibleTools(delJson.taskId).map((t) => t.name);
        assert.ok(!workerTools.includes("timo_delegate_task"));
        assert.ok(!workerTools.includes("timo_list_skills"));

        await client.close();
        gateway.revokeChief(chief.nonce);

        // 2. HTTP API round-trip for /api/skills and /api/chat contextSummary
        const router = new Router();
        registerApi(router, {
          service,
          ledger: writer.ledger,
          bus,
          startedAt: new Date().toISOString(),
          t3Configured: false,
          settingsStore,
          skillRegistry,
          chatStore,
          chatBus,
          mcpGateway: gateway,
        });
        const callApi = async (method: string, path: string, body?: unknown) => {
          const match = await router.dispatch({ method, path, query: new URLSearchParams(), params: {}, body, accept: "application/json", trustedLocal: true });
          assert.ok(match);
          return match.route.handler({ method, path, query: new URLSearchParams(), params: match.params, body, accept: "application/json", trustedLocal: true });
        };

        const chatGet = await callApi("GET", "/api/chat");
        const ctxSummary = (chatGet.body as { contextSummary: { enabledSkillCount: number; chiefMcpTools: string[] } }).contextSummary;
        assert.equal(ctxSummary.enabledSkillCount, 1);
        assert.ok(ctxSummary.chiefMcpTools.includes("timo_delegate_task"));

        await callApi("PATCH", "/api/skills/pr-summary", { enabled: false, scope: "chat" });
        const skillsAfter = await callApi("GET", "/api/skills");
        const rec = (skillsAfter.body as { skills: Array<{ id: string; enabled: boolean; scope: string }> }).skills[0]!;
        assert.equal(rec.enabled, false);
        assert.equal(rec.scope, "chat");
      } finally {
        await gateway.close();
        service.close();
      }
    });
  });
});
