import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defaultConfig } from "../src/config.js";
import { TaskService } from "../src/service/task-service.js";
import { SettingsStore } from "../src/settings.js";
import { SkillRegistry, parseSkillMarkdown, parseSlashSkillInvocation, selectActiveSkills } from "../src/skills/registry.js";
import { ChatStore, ChatStreamBus } from "../src/store/chat.js";
import { MainChatRunner, isTimoManagementIntent } from "../src/service/chat-runner.js";
import { resolveValidBaseRef, selectFoldersForRequest } from "../src/workspace/inspect.js";
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

  it("surfaces structured executor error messages in Main Chat instead of bare 'failed'", async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const { service, db } = TaskService.open(defaultConfig({}, home));
      const chatStore = new ChatStore(db);
      const chatBus = new ChatStreamBus();
      const failingAdapter: ExecutionAdapter = {
        id: "codex",
        async probe() {
          return { id: "codex", kind: "cli", available: true, capabilities: { stream: true } };
        },
        async spawn(req: SpawnRequest, onEvent: (ev: RunStreamEvent) => void): Promise<SpawnResult> {
          onEvent({
            seq: 1,
            runId: req.runId,
            taskId: req.taskId,
            type: "error",
            at: Date.now(),
            summary: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
          });
          return { runId: req.runId, externalId: null, status: "failed", exitCode: 1, output: "" };
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
      registry.register(failingAdapter);
      await registry.probeAll();
      try {
        const runner = new MainChatRunner({ home, chatStore, chatBus, service, executors: registry });
        const res = runner.send({ text: "测试模型报错提示", executorId: "codex" });
        assert.equal(res.kind, "chat");
        await new Promise((r) => setTimeout(r, 40));
        const saved = chatStore.get(res.assistantMessage.messageId);
        assert.ok(saved);
        assert.equal(saved.status, "error");
        assert.match(saved.content, /model is not supported/);
        assert.match(saved.content, /切换其他模型或执行器/);
      } finally {
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

  it("never routes skill import requests (with hyphenated skill names like data-agent-skill) to repo_delivery, follows skill symlinks, and resolves valid git baseRef", async () => {
    await withTempDir(async (dir) => {
      // 1. Repo initialized on `master` (no `main` ref!)
      const repoDir = join(dir, "data-agent");
      mkdirSync(repoDir, { recursive: true });
      writeFileSync(join(repoDir, "README.md"), "# data-agent\n", "utf8");
      execFileSync("git", ["init", "-b", "master"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      execFileSync("git", ["add", "README.md"], { cwd: repoDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

      assert.equal(resolveValidBaseRef(repoDir, "main"), "master");

      const folders = [{ id: "data-agent", name: "data-agent", path: repoDir, kind: "git" as const, baseRef: "main" }];
      // Hyphenated skill names MUST NOT false-match repo `data-agent`
      const skillImportPrompt =
        "你能帮我导入吗？\nDataAgent (2) data-agent-skill, data-agent-case-eval\ncloudspec-operation-edit\n可以结合 aliyun-runbook 中规定 skill";
      assert.deepEqual(selectFoldersForRequest(skillImportPrompt, folders), []);
      assert.equal(isTimoManagementIntent(skillImportPrompt), true);
      // Actual repo reference still matches cleanly
      assert.deepEqual(
        selectFoldersForRequest("请帮我修复 data-agent 里的超时问题", folders).map((f) => f.name),
        ["data-agent"],
      );

      // 2. Symlinked external skill folder discovery + importByNames
      const home = join(dir, "timo-home");
      const fakeUserHome = join(dir, "user-home");
      const realSkillDir = join(dir, "store", "data-agent-skill");
      mkdirSync(realSkillDir, { recursive: true });
      writeFileSync(
        join(realSkillDir, "SKILL.md"),
        "---\nname: data-agent-skill\ndescription: DataAgent 常用排障流程\n---\n按步骤检查配置。",
        "utf8",
      );
      const qwenSkillsDir = join(fakeUserHome, ".qwen", "skills");
      mkdirSync(qwenSkillsDir, { recursive: true });
      symlinkSync(realSkillDir, join(qwenSkillsDir, "data-agent-skill"));

      const registry = new SkillRegistry(home, { HOME: fakeUserHome });
      const sources = registry.discoverExternalSources();
      assert.equal(sources.length, 1);
      assert.equal(sources[0]?.skills[0]?.id, "data-agent-skill");

      const res = registry.importByNames(["data-agent-skill", "dataagent-user-trace"]);
      assert.deepEqual(res.imported, ["data-agent-skill"]);
      assert.deepEqual(res.notFound, ["dataagent-user-trace"]);

      // 3. Chief MCP `timo_import_skills` works by skillIds without needing sourceDir
      const config = defaultConfig({}, home);
      const { service, db } = TaskService.open(config);
      const settingsStore = new SettingsStore(home, {});
      settingsStore.save({ ...settingsStore.load(), folders });
      const gateway = new CapabilityMcpGateway({ service, port: 0 });
      registerChiefTools(gateway, {
        service,
        settingsStore,
        skillRegistry: registry,
        chatStore: new ChatStore(db),
        chatBus: new ChatStreamBus(),
      });
      await gateway.start();
      try {
        const chief = gateway.issueChiefToken();
        const client = new McpClient({ name: "import-test", version: "1.0.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(chief.url)));
        const impRes = await client.callTool({
          name: "timo_import_skills",
          arguments: { skillIds: ["data-agent-skill", "missing-skill"], overwrite: true },
        });
        const impJson = JSON.parse((impRes.content as Array<{ text: string }>)[0]!.text) as {
          imported: string[];
          notFound: string[];
        };
        assert.deepEqual(impJson.imported, ["data-agent-skill"]);
        assert.deepEqual(impJson.notFound, ["missing-skill"]);
        await client.close();
        gateway.revokeChief(chief.nonce);
      } finally {
        await gateway.close();
        service.close();
      }
    });
  });

  it("supports all 6 YAML block scalars in parseSkillMarkdown, Chief HTTP /call bridge for non-MCP adapters (Pi), and full recent chat memory", async () => {
    // 1. YAML block scalars (|, |-, |+, >, >-, >+)
    const literal = parseSkillMarkdown("---\nname: s1\ndescription: |\n  第一行\n  第二行\nscope: global\n---\nBody", "s1");
    assert.equal(literal.description, "第一行\n第二行");
    assert.equal(literal.scope, "global");

    const foldedStrip = parseSkillMarkdown("---\nname: s2\ndescription: >-\n  用于智能变更与发布，\n  支持回滚。\n\n  第二段说明。\nscope: chat\n---\nBody", "s2");
    assert.equal(foldedStrip.description, "用于智能变更与发布， 支持回滚。\n第二段说明。");
    assert.equal(foldedStrip.scope, "chat");

    const literalStrip = parseSkillMarkdown("---\nname: s3\ndescription: |-\n    缩进四格\n      缩进六格\n---\nBody", "s3");
    assert.equal(literalStrip.description, "缩进四格\n  缩进六格");

    const folded = parseSkillMarkdown("---\nname: s4\ndescription: >\n  line one\n  line two\n---\nBody", "s4");
    assert.equal(folded.description, "line one line two");

    // 2. Chief HTTP JSON shortcut `/mcp/chief/:nonce/call` + Pi prompt bridge + long recent chat history
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const repoDir = join(dir, "timo");
      mkdirSync(repoDir, { recursive: true });
      writeFileSync(join(repoDir, "README.md"), "# timo\n", "utf8");
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      execFileSync("git", ["add", "README.md"], { cwd: repoDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

      const { service, db } = TaskService.open(defaultConfig({}, home));
      const settingsStore = new SettingsStore(home, {});
      settingsStore.save({ ...settingsStore.load(), folders: [{ id: "timo", name: "timo", path: repoDir, kind: "git", baseRef: "main" }] });
      const chatStore = new ChatStore(db);
      const chatBus = new ChatStreamBus();
      const gateway = new CapabilityMcpGateway({ service, port: 0 });
      registerChiefTools(gateway, { service, settingsStore, chatStore, chatBus });
      await gateway.start();

      // Seed a long >1000-char previous assistant message whose tail holds Option A/B
      const longPrev = `${"背景分析 ".repeat(110)}\n\n## 方案选项\n- **A**: 修复 parseSkillMarkdown\n- **B**: 清理重复源`;
      chatStore.append({ role: "user", content: "分析问题" });
      chatStore.append({ role: "assistant", content: longPrev, status: "done" });

      let capturedPrompt = "";
      let capturedUrl = "";
      const piLikeAdapter: ExecutionAdapter = {
        id: "pi",
        async probe() {
          return { id: "pi", kind: "cli", available: true, capabilities: { stream: true, mcpGateway: false } };
        },
        async spawn(req: SpawnRequest): Promise<SpawnResult> {
          capturedPrompt = req.prompt;
          capturedUrl = req.mcpGatewayUrl ?? "";
          // Simulate Pi calling the Chief HTTP shortcut via curl/fetch during the turn!
          const callRes = await fetch(`${capturedUrl}/call`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              tool: "timo_delegate_task",
              args: { requestText: "修复 parseSkillMarkdown 块标量解析", repoNames: ["timo"] },
            }),
          });
          assert.equal(callRes.status, 200);
          const payload = (await callRes.json()) as { data?: { taskId?: string } };
          assert.ok(payload.data?.taskId);
          return { runId: req.runId, externalId: "pi-1", status: "succeeded", exitCode: 0, output: "已派发后台修复任务。" };
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
      const executors = new ExecutorRegistry();
      executors.register(piLikeAdapter);
      await executors.probeAll();

      try {
        const runner = new MainChatRunner({ home, chatStore, chatBus, service, executors, settingsStore, mcpGateway: gateway });
        runner.send({ text: "A", executorId: "pi" });
        await new Promise((r) => setTimeout(r, 80));

        // Latest assistant message tail MUST NOT be truncated at 400 chars!
        assert.match(capturedPrompt, /修复 parseSkillMarkdown/);
        // Pi MUST receive HTTP `/call` bridge instructions instead of native MCP claim
        assert.match(capturedPrompt, /TIMO_MCP_GATEWAY_URL\/call/);
        // Delegated task + inline card MUST exist
        assert.equal(service.listTasks(20, undefined, { archived: "all" }).length, 1);
        assert.equal(chatStore.list(30).filter((m) => m.role === "task_card").length, 1);
        // After turn finishes, `/call` with the old nonce MUST return 403 SESSION_REVOKED
        const afterRes = await fetch(`${capturedUrl}/call`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tool: "timo_list_tasks", args: {} }),
        });
        assert.equal(afterRes.status, 403);
      } finally {
        await gateway.close();
        service.close();
      }
    });
  });
});
