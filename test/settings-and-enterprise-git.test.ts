import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../src/settings.js";
import { assembleTaskContext, formatAssembledContext } from "../src/knowledge/context.js";
import { EnterpriseGitPlatformAdapter, PlatformEffectUnknownError } from "../src/platform/adapter.js";
import { TaskService } from "../src/service/task-service.js";
import { defaultConfig } from "../src/config.js";
import { Router } from "../src/http/server.js";
import { registerApi } from "../src/http/routes.js";
import { discoverExecutorProviders } from "../src/adapters/providers.js";
import { inspectLocalFolder, parseGitRemote, scanWorkspaceRoot, selectFoldersForRequest } from "../src/workspace/inspect.js";
import { RunStreamStore } from "../src/workspace/run-stream.js";
import { ChatStore, ChatStreamBus } from "../src/store/chat.js";
import { MainChatRunner } from "../src/service/chat-runner.js";
import { ExecutorRegistry, type ExecutionAdapter, type RunStreamEvent, type SpawnRequest, type SpawnResult } from "../src/adapters/execution.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { VerifierRegistry } from "../src/verify/pipeline.js";
import { execFileSync } from "node:child_process";

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "timo-settings-test-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("SettingsStore, Knowledge Base & Isolated Credentials", () => {
  it("persists non-secret settings and keeps credentials strictly isolated (0600, no plaintext echo)", async () => {
    await withTempDir((dir) => {
      const home = join(dir, "home");
      const repoDir = join(dir, "repo-a");
      const docsDir = join(dir, "docs");
      mkdirSync(join(repoDir, ".git"), { recursive: true });
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, "arch.md"), "# 订单域架构\n服务入口：order-api\n误写 token=super_secret_12345\n", "utf8");

      const store = new SettingsStore(home, { GH_TOKEN: "env_gh_secret" });
      const saved = store.save({
        assistant: {
          defaultExecutor: "pi",
          executorModels: { codex: "gpt-5.4", pi: "" },
          systemPrompt: "始终用中文回复并先补单测。",
          defaultMaxRepairRounds: 3,
        },
        defaultProjectId: "repo-a",
        projects: [
          {
            id: "repo-a",
            name: "repo-a",
            localPath: repoDir,
            baseRef: "master",
            checkCommand: "npm test",
            platformId: "corp-git",
            remoteRepo: "team/repo-a",
            description: "核心订单服务",
          },
        ],
        knowledge: [
          { id: "arch", name: "架构文档", path: docsDir, scope: "repo-a", enabled: true },
        ],
        connections: [
          {
            id: "corp-git",
            name: "企业代码平台",
            kind: "enterprise_git",
            baseUrl: "https://code.example.com/",
            apiPath: "/api/v4",
            authHeader: "PRIVATE-TOKEN",
            credentialKey: "ENTERPRISE_GIT_TOKEN",
            notes: "企业内部 Git 平台",
          },
        ],
      });

      assert.equal(saved.assistant.defaultExecutor, "pi");
      assert.deepEqual(saved.assistant.executorModels, { codex: "gpt-5.4" });
      assert.equal(saved.connections[0]?.baseUrl, "https://code.example.com");

      // Save credential into isolated 0600 file.
      const status = store.setCredential("ENTERPRISE_GIT_TOKEN", "glpat-secret-value");
      assert.deepEqual(status, { key: "ENTERPRISE_GIT_TOKEN", configured: true, source: "file" });
      const mode = statSync(store.credentialsPath).mode & 0o777;
      assert.equal(mode, 0o600);

      // Status list never exposes raw secret values.
      const statuses = store.listCredentialStatuses();
      assert.equal(JSON.stringify(statuses).includes("glpat-secret-value"), false);
      assert.equal(JSON.stringify(statuses).includes("env_gh_secret"), false);
      assert.equal(statuses.find((s) => s.key === "GH_TOKEN")?.source, "env");
      assert.equal(statuses.find((s) => s.key === "ENTERPRISE_GIT_TOKEN")?.source, "file");

      // Gateway resolver DOES receive credentials.
      const gwCreds = store.resolveGatewayCredentials();
      assert.equal(gwCreds.ENTERPRISE_GIT_TOKEN, "glpat-secret-value");
      assert.equal(gwCreds.GH_TOKEN, "env_gh_secret");

      // Path inspection verifies git repo & knowledge dir.
      const inspected = store.inspectPaths(saved);
      assert.deepEqual(inspected.projects["repo-a"], { exists: true, isGitRepo: true });
      assert.deepEqual(inspected.knowledge["arch"], { exists: true, kind: "dir" });

      // Knowledge context assembly includes system prompt, project metadata, non-secret service catalog,
      // and redacts accidental secrets in docs.
      const ctx = assembleTaskContext(saved, [repoDir]);
      const formatted = formatAssembledContext(ctx);
      assert.match(formatted, /始终用中文回复并先补单测/);
      assert.match(formatted, /核心订单服务/);
      assert.match(formatted, /https:\/\/code\.example\.com/);
      assert.match(formatted, /订单域架构/);
      assert.equal(formatted.includes("super_secret_12345"), false);
      assert.equal(formatted.includes("glpat-secret-value"), false);
    });
  });
});

describe("EnterpriseGitPlatformAdapter", () => {
  it("creates MR idempotently, checks CI, and reports effect_unknown on timeout", async () => {
    const requests: Array<{ url: string; method: string; token: string | null }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ url, method, token: headers["PRIVATE-TOKEN"] ?? null });

      if (method === "GET" && url.includes("/merge_requests?state=opened")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (method === "POST" && url.endsWith("/merge_requests")) {
        return new Response(
          JSON.stringify({
            iid: 42,
            web_url: "https://code.example.com/team/order-api/merge_requests/42",
            source_branch: "timo/fix",
            target_branch: "master",
            sha: "abc12345",
          }),
          { status: 201 },
        );
      }
      if (method === "GET" && url.endsWith("/merge_requests/42")) {
        return new Response(JSON.stringify({ sha: "abc12345", head_pipeline: { status: "success" } }), { status: 200 });
      }
      if (method === "GET" && url.includes("/statuses")) {
        return new Response(JSON.stringify([{ name: "unit-test", status: "success" }]), { status: 200 });
      }
      if (method === "GET" && url.endsWith("/user")) {
        return new Response(JSON.stringify({ username: "dev" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const adapter = new EnterpriseGitPlatformAdapter({
      baseUrl: "https://code.example.com",
      apiPath: "/api/v4",
      authHeader: "PRIVATE-TOKEN",
      credentialKey: "ENTERPRISE_GIT_TOKEN",
      fetchImpl: fakeFetch,
    });

    const creds = { ENTERPRISE_GIT_TOKEN: "corp-tok-999" };
    const receipt = await adapter.createOrUpdateMr(
      {
        repo: "team/order-api",
        branch: "timo/fix",
        baseRef: "master",
        headSha: "abc12345",
        title: "Fix retry bug",
        body: "Details",
        clientRequestId: "op-1",
      },
      creds,
    );
    assert.equal(receipt.mrId, "42");
    assert.equal(receipt.url, "https://code.example.com/team/order-api/merge_requests/42");
    assert.equal(requests[1]?.token, "corp-tok-999");

    const ci = await adapter.getCiStatus({ repo: "team/order-api", mrId: "42", expectedHeadSha: "abc12345" }, creds);
    assert.equal(ci.status, "passed");
    assert.equal(ci.headSha, "abc12345");

    const probe = await adapter.testConnection(creds);
    assert.equal(probe.ok, true);

    // Timeout during POST MR must throw PlatformEffectUnknownError (Intent-Before-Effect!).
    const timeoutAdapter = new EnterpriseGitPlatformAdapter({
      baseUrl: "https://code.example.com",
      fetchImpl: async (_url, init) => {
        if ((init?.method ?? "GET") === "POST") throw new Error("socket hang up");
        return new Response(JSON.stringify([]), { status: 200 });
      },
    });
    await assert.rejects(
      () =>
        timeoutAdapter.createOrUpdateMr(
          {
            repo: "team/order-api",
            branch: "timo/fix",
            baseRef: "master",
            headSha: "abc12345",
            title: "Fix retry bug",
            body: "Details",
            clientRequestId: "op-2",
          },
          creds,
        ),
      PlatformEffectUnknownError,
    );
  });
});

describe("Settings HTTP Routes & Human-Readable Task Titles", () => {
  it("serves GET/PUT /api/settings, /api/credentials and exposes task titles", async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const config = defaultConfig({}, home);
      const { service, bus, writer } = TaskService.open(config);
      try {
        const settingsStore = new SettingsStore(home, {});
        const router = new Router();
        registerApi(router, {
          service,
          ledger: writer.ledger,
          bus,
          startedAt: new Date().toISOString(),
          t3Configured: false,
          settingsStore,
        });

        const dispatch = async (method: string, path: string, body?: unknown) => {
          const match = await router.dispatch({
            method,
            path,
            query: new URLSearchParams(),
            params: {},
            body,
            accept: "application/json",
            trustedLocal: true,
          });
          assert.ok(match, `route ${method} ${path} should match`);
          return match.route.handler({
            method,
            path,
            query: new URLSearchParams(),
            params: match.params,
            body,
            accept: "application/json",
            trustedLocal: true,
          });
        };

        const putRes = await dispatch("PUT", "/api/settings", {
          assistant: { defaultExecutor: "qwen-code", systemPrompt: "使用中文" },
          projects: [{ name: "demo", localPath: dir, baseRef: "main", checkCommand: "npm test" }],
        });
        assert.equal((putRes.body as { settings: { assistant: { systemPrompt: string } } }).settings.assistant.systemPrompt, "使用中文");

        const credRes = await dispatch("PUT", "/api/credentials", { key: "ENTERPRISE_GIT_TOKEN", value: "tok-123" });
        const credBody = credRes.body as { credential: { key: string; configured: boolean; source: string } };
        assert.deepEqual(credBody.credential, { key: "ENTERPRISE_GIT_TOKEN", configured: true, source: "file" });
        assert.equal(JSON.stringify(credRes.body).includes("tok-123"), false);

        // Create a repo task and verify listTasks returns human-readable title.
        const created = await dispatch("POST", "/api/tasks", {
          requestId: "req-title-1",
          kind: "repo_delivery",
          requestText: "新增企业内部 Git 平台适配\n补充单测并更新界面",
          repos: [{ sourcePath: dir, baseRef: "main", name: "demo" }],
        });
        const taskId = (created.body as { taskId: string }).taskId;
        const listRes = await dispatch("GET", "/api/tasks");
        const first = (listRes.body as { tasks: Array<{ taskId: string; title: string; repoNames: string[] }> }).tasks[0];
        assert.equal(first?.taskId, taskId);
        assert.equal(first?.title, "新增企业内部 Git 平台适配");
        assert.deepEqual(first?.repoNames, ["demo"]);
      } finally {
        service.close();
      }
    });
  });

  it("discovers non-secret provider & model catalogs for pi, qwen-code, codex, and opencode", async () => {
    await withTempDir((dir) => {
      mkdirSync(join(dir, ".pi/agent"), { recursive: true });
      mkdirSync(join(dir, ".qwen"), { recursive: true });
      mkdirSync(join(dir, ".codex"), { recursive: true });
      mkdirSync(join(dir, ".config/opencode"), { recursive: true });

      writeFileSync(join(dir, ".pi/agent/settings.json"), JSON.stringify({ defaultProvider: "custom-openai", defaultModel: "claude-sonnet-4" }), "utf8");
      writeFileSync(
        join(dir, ".qwen/settings.json"),
        JSON.stringify({
          model: { name: "qwen3-coder" },
          modelProviders: { openai: [{ id: "qwen3-coder", name: "Qwen3 Coder", apiKey: "SECRET_SHOULD_NOT_LEAK" }] },
        }),
        "utf8",
      );
      writeFileSync(join(dir, ".codex/config.toml"), 'model = "gpt-5.4"\n[model_providers.corp]\nbase_url = "https://example.invalid"\n', "utf8");
      writeFileSync(
        join(dir, ".codex/models_cache.json"),
        JSON.stringify({
          models: [
            { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list" },
            { slug: "hidden-model", display_name: "Hidden", visibility: "hide" },
          ],
        }),
        "utf8",
      );
      writeFileSync(join(dir, ".config/opencode/opencode.json"), JSON.stringify({ model: "openrouter/qwen3-coder" }), "utf8");

      const catalogs = discoverExecutorProviders({
        homeDir: dir,
        runCli: (cmd) => {
          if (cmd === "pi") return "provider model context\ncustom-openai claude-sonnet-4 200K\nopenrouter qwen3-coder 1M\n";
          if (cmd === "opencode") return "openrouter/qwen3-coder\nopencode/big-pickle\n";
          return null;
        },
      });

      assert.equal(catalogs.pi?.defaultProvider, "custom-openai");
      assert.equal(catalogs.pi?.providers.length, 2);
      assert.equal(catalogs.pi?.providers[0]?.models[0]?.id, "custom-openai/claude-sonnet-4");

      assert.equal(catalogs["qwen-code"]?.defaultModel, "qwen3-coder");
      assert.equal(catalogs["qwen-code"]?.providers[0]?.id, "openai");
      assert.equal(JSON.stringify(catalogs).includes("SECRET_SHOULD_NOT_LEAK"), false);

      assert.equal(catalogs.codex?.defaultModel, "gpt-5.4");
      assert.equal(catalogs.codex?.providers.some((p) => p.id === "openai" && p.models.length === 1), true);
      assert.equal(catalogs.codex?.providers.some((p) => p.id === "corp"), true);

      assert.equal(catalogs.opencode?.defaultProvider, "openrouter");
      assert.equal(catalogs.opencode?.providers.length, 2);
    });
  });

  it("auto-inspects local Git & docs folders and parses SSH/HTTPS enterprise remotes", async () => {
    await withTempDir((dir) => {
      const docsDir = join(dir, "runbooks");
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, "guide.md"), "# 运维手册\n", "utf8");

      const inspectedDocs = inspectLocalFolder(docsDir);
      assert.equal(inspectedDocs.exists, true);
      assert.equal(inspectedDocs.kind, "docs");
      assert.equal(inspectedDocs.name, "runbooks");

      const inspectedRepo = inspectLocalFolder(process.cwd());
      assert.equal(inspectedRepo.exists, true);
      assert.equal(inspectedRepo.kind, "git");
      assert.ok(inspectedRepo.baseRef);
      assert.equal(inspectedRepo.detectedCheckCommand, "npm run typecheck && npm test");

      assert.deepEqual(parseGitRemote("git@code.example.com:team/sub/order-api.git"), {
        host: "code.example.com",
        repo: "team/sub/order-api",
      });
      assert.deepEqual(parseGitRemote("https://code.example.com/team/order-api.git"), {
        host: "code.example.com",
        repo: "team/order-api",
      });

      // scanWorkspaceRoot discovers nested git repos without descending inside them.
      const rootDir = join(dir, "codebase");
      mkdirSync(join(rootDir, "order-api/.git"), { recursive: true });
      mkdirSync(join(rootDir, "order-api/sub-ignored/.git"), { recursive: true });
      mkdirSync(join(rootDir, "web-ui/.git"), { recursive: true });
      const scanned = scanWorkspaceRoot(rootDir, 2);
      assert.deepEqual(
        scanned.map((s) => s.name),
        ["order-api", "web-ui"],
      );

      // selectFoldersForRequest matches explicitly mentioned folders automatically,
      // and returns [] for greetings/general chat so Timo never mounts unrelated repos.
      const selected = selectFoldersForRequest("帮我修复 order-api 的超时重试问题", scanned);
      assert.deepEqual(
        selected.map((s) => s.name),
        ["order-api"],
      );
      assert.deepEqual(selectFoldersForRequest("你好", scanned), []);
    });
  });

  it("routes general chat ('你好') with repos:[] to assistant_chat instead of mounting repos", async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const config = defaultConfig({}, home);
      const { service, bus, writer } = TaskService.open(config);
      try {
        const settingsStore = new SettingsStore(home, {});
        const router = new Router();
        registerApi(router, {
          service,
          ledger: writer.ledger,
          bus,
          startedAt: new Date().toISOString(),
          t3Configured: false,
          settingsStore,
        });
        const match = await router.dispatch({
          method: "POST",
          path: "/api/tasks",
          query: new URLSearchParams(),
          params: {},
          body: { requestId: "chat-hi-1", kind: "repo_delivery", requestText: "你好", executorId: "qwen-code", repos: [] },
          accept: "application/json",
          trustedLocal: true,
        });
        assert.ok(match);
        const res = await match.route.handler({
          method: "POST",
          path: "/api/tasks",
          query: new URLSearchParams(),
          params: match.params,
          body: { requestId: "chat-hi-1", kind: "repo_delivery", requestText: "你好", executorId: "qwen-code", repos: [] },
          accept: "application/json",
          trustedLocal: true,
        });
        const taskId = (res.body as { taskId: string }).taskId;
        const detail = service.getTask(taskId);
        assert.equal(detail.kind, "assistant_chat");
        assert.deepEqual(detail.repos, []);

        service.completeAssistantChat(taskId, "run-chat-1", "你好！我是 Timo，有什么可以帮你的？");
        const done = service.getTask(taskId);
        assert.equal(done.status, "completed");
        assert.equal((done.result as { assistantText?: string })?.assistantText, "你好！我是 Timo，有什么可以帮你的？");
      } finally {
        service.close();
      }
    });
  });

  it("supports full task CRUD + archive lifecycle (rename, archive/unarchive filter, delete & force-delete cleanup)", async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const config = defaultConfig({}, home);
      const { service, bus, writer } = TaskService.open(config);
      const runStreams = new RunStreamStore(home);
      const interrupted: string[] = [];
      try {
        const router = new Router();
        registerApi(router, {
          service,
          ledger: writer.ledger,
          bus,
          startedAt: new Date().toISOString(),
          t3Configured: false,
          runStreams,
          interruptActive: async (taskId) => {
            interrupted.push(taskId);
          },
        });
        const dispatch = async (method: string, path: string, body?: unknown, queryStr = "") => {
          const query = new URLSearchParams(queryStr);
          const match = await router.dispatch({ method, path, query, params: {}, body, accept: "application/json", trustedLocal: true });
          assert.ok(match, `route ${method} ${path} should match`);
          return match.route.handler({ method, path, query, params: match.params, body, accept: "application/json", trustedLocal: true });
        };

        const c1 = await dispatch("POST", "/api/tasks", {
          requestId: "crud-1",
          kind: "assistant_chat",
          requestText: "整理接口文档",
          executorId: "qwen-code",
        });
        const c2 = await dispatch("POST", "/api/tasks", {
          requestId: "crud-2",
          kind: "assistant_chat",
          requestText: "排查超时原因",
          executorId: "pi",
        });
        const id1 = (c1.body as { taskId: string }).taskId;
        const id2 = (c2.body as { taskId: string }).taskId;

        // Rename task 1
        const renamed = await dispatch("PATCH", `/api/tasks/${id1}`, { title: "新标题 · 接口文档整理" });
        assert.equal((renamed.body as { title: string }).title, "新标题 · 接口文档整理");
        assert.equal(service.getTask(id1).title, "新标题 · 接口文档整理");

        // Archive task 1 and verify list filters (exclude / only / all)
        const archived = await dispatch("PATCH", `/api/tasks/${id1}`, { archived: true });
        assert.ok((archived.body as { archivedAt: string | null }).archivedAt);

        const activeOnly = await dispatch("GET", "/api/tasks");
        assert.deepEqual(
          (activeOnly.body as { tasks: Array<{ taskId: string }> }).tasks.map((t) => t.taskId),
          [id2],
        );
        const archivedOnly = await dispatch("GET", "/api/tasks", undefined, "archived=only");
        assert.deepEqual(
          (archivedOnly.body as { tasks: Array<{ taskId: string }> }).tasks.map((t) => t.taskId),
          [id1],
        );
        const allTasks = await dispatch("GET", "/api/tasks", undefined, "archived=all");
        assert.equal((allTasks.body as { tasks: unknown[] }).tasks.length, 2);

        // Unarchive task 1 and reset custom title back to default
        const unarchived = await dispatch("PATCH", `/api/tasks/${id1}`, { archived: false, title: "" });
        assert.equal((unarchived.body as { archivedAt: string | null }).archivedAt, null);
        assert.equal((unarchived.body as { title: string }).title, "整理接口文档");

        // Complete task 1 -> normal delete succeeds
        service.completeAssistantChat(id1, "run-1", "完成");
        runStreams.append({ seq: 1, runId: "run-1", taskId: id1, type: "status", at: Date.now(), summary: "done" });
        assert.equal(runStreams.listRuns(id1).length, 1);

        const del1 = await dispatch("DELETE", `/api/tasks/${id1}`);
        assert.equal((del1.body as { deleted: boolean }).deleted, true);
        assert.equal(runStreams.listRuns(id1).length, 0);

        // Task 2 is still active (`accepted`): delete without force returns 409 task_active
        await assert.rejects(
          () => dispatch("DELETE", `/api/tasks/${id2}`),
          (err: unknown) => {
            const e = err as { status?: number; code?: string };
            return e.status === 409 && e.code === "task_active";
          },
        );

        // Force delete interrupts active run and deletes task 2 cleanly
        const del2 = await dispatch("DELETE", `/api/tasks/${id2}`, undefined, "force=1");
        assert.equal((del2.body as { deleted: boolean }).deleted, true);
        assert.deepEqual(interrupted, [id2]);
        const afterAll = await dispatch("GET", "/api/tasks", undefined, "archived=all");
        assert.equal((afterAll.body as { tasks: unknown[] }).tasks.length, 0);
      } finally {
        service.close();
      }
    });
  });

  it("supports inbox dismiss (for blocked/verified cards, never red-line decisions) and explicit task retry", async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const config = defaultConfig({}, home);
      const { service, bus, writer } = TaskService.open(config);
      try {
        const router = new Router();
        registerApi(router, {
          service,
          ledger: writer.ledger,
          bus,
          startedAt: new Date().toISOString(),
          t3Configured: false,
        });
        const dispatch = async (method: string, path: string, body?: unknown) => {
          const match = await router.dispatch({ method, path, query: new URLSearchParams(), params: {}, body, accept: "application/json", trustedLocal: true });
          assert.ok(match);
          return match.route.handler({ method, path, query: new URLSearchParams(), params: match.params, body, accept: "application/json", trustedLocal: true });
        };

        const c = await dispatch("POST", "/api/tasks", {
          requestId: "retry-1",
          kind: "assistant_chat",
          requestText: "你好",
          executorId: "qwen-code",
        });
        const taskId = (c.body as { taskId: string }).taskId;

        // Simulate a task failure -> creates `task_blocked_final` in Inbox
        writer.commit({
          taskId,
          type: "task_failed",
          payload: { reason: "timed_out", detail: "executor qwen-code ended with timed_out" },
          options: { idempotencyKey: "failed:g1:timed_out", now: new Date().toISOString() },
          project: () => {
            service.row(taskId);
            // Move DB task to failed state
            const db = (service as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
            db.prepare("UPDATE tasks SET status = 'failed', failure_reason = 'timed_out' WHERE task_id = ?").run(taskId);
          },
        });
        assert.equal(service.listInbox().some((i) => i.taskId === taskId && i.decisionKey === "task_blocked_final"), true);

        // Dismissing red-line `decision_required` is refused (400)
        await assert.rejects(
          () => dispatch("POST", `/api/inbox/${taskId}/decision_required/dismiss`, {}),
          (err: unknown) => (err as { status?: number }).status === 400,
        );

        // Retry task clears inbox item, clears failure_reason, bumps generation to g2, and re-enqueues dispatch
        const retried = await dispatch("POST", `/api/tasks/${taskId}/retry`, {});
        assert.equal((retried.body as { status: string }).status, "accepted");
        assert.equal((retried.body as { generation: number }).generation, 2);
        assert.equal(service.getTask(taskId).failureReason, null);
        assert.equal(service.listInbox().length, 0);

        // Complete task -> completed tasks MUST NOT create an actionable Inbox item (product invariant)
        service.completeAssistantChat(taskId, "run-g2", "你好！");
        assert.equal(service.listInbox().length, 0);

        // Manually simulate another blocked inbox item and verify explicit dismiss clears it
        service.inbox.upsert({
          taskId,
          decisionKey: "task_blocked_final",
          title: "任务执行阻塞",
          summary: "timeout",
          options: ["重试", "停止"],
        });
        assert.equal(service.listInbox().length, 1);
        const dismissed = await dispatch("POST", `/api/inbox/${taskId}/task_blocked_final/dismiss`, {});
        assert.equal((dismissed.body as { dismissed: boolean }).dismissed, true);
        assert.equal(service.listInbox().length, 0);
      } finally {
        service.close();
      }
    });
  });

  it("product invariants: Main Chat streams deltas with ZERO junk tasks, delegates repo work as a single task_card, and verifier links node_modules", async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const repoDir = join(dir, "demo-app");
      mkdirSync(join(repoDir, "node_modules/.bin"), { recursive: true });
      writeFileSync(join(repoDir, "index.js"), "export const ok = true;\n", "utf8");
      writeFileSync(join(repoDir, "node_modules/marker.txt"), "installed", "utf8");
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      writeFileSync(join(repoDir, ".gitignore"), "node_modules/\n", "utf8");
      execFileSync("git", ["add", "index.js", ".gitignore"], { cwd: repoDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

      // 1. VerificationPipeline clean checkout links node_modules without polluting source repo
      const workspaces = new WorkspaceManager({ home: join(home, "workspaces") });
      const verifiers = new VerifierRegistry();
      const verifyOutcome = await verifiers.run(
        {
          version: "test-v1",
          steps: [{ type: "command_check", name: "check-deps", command: "test -f node_modules/marker.txt", repo: "demo-app" }],
        },
        {
          taskId: "t-verify-nm",
          briefVersion: 1,
          repos: [{ name: "demo-app", sourcePath: repoDir, baseRef: "main", baseSha: headSha, headSha }],
          workspaces,
        },
      );
      assert.equal(verifyOutcome.status, "accepted");
      assert.equal(existsSync(join(repoDir, "node_modules/marker.txt")), true);

      // 2. MainChatRunner: casual greeting streams SSE deltas and creates ZERO tasks & ZERO inbox items
      const config = defaultConfig({}, home);
      const { service, db } = TaskService.open(config);
      try {
        const settingsStore = new SettingsStore(home, {});
        settingsStore.save({
          ...settingsStore.load(),
          folders: [{ id: "f1", name: "demo-app", path: repoDir, kind: "git", baseRef: "main" }],
        });
        const chatStore = new ChatStore(db);
        const chatBus = new ChatStreamBus();
        const frames: string[] = [];
        const deltas: string[] = [];
        chatBus.subscribe((f) => {
          frames.push(f.event);
          if (f.event === "chat_delta") deltas.push(f.data.delta);
        });

        const spawnCwds: string[] = [];
        const fakeAdapter: ExecutionAdapter = {
          id: "qwen-code",
          async probe() {
            return { id: "qwen-code", kind: "cli", available: true, capabilities: { stream: true } };
          },
          async spawn(req: SpawnRequest, onEvent: (ev: RunStreamEvent) => void): Promise<SpawnResult> {
            spawnCwds.push(req.cwd);
            onEvent({ seq: 1, runId: req.runId, taskId: req.taskId, type: "text_delta", at: Date.now(), summary: "你好，" });
            onEvent({ seq: 2, runId: req.runId, taskId: req.taskId, type: "text_delta", at: Date.now(), summary: "我是 Timo！" });
            return { runId: req.runId, externalId: "ext-1", status: "succeeded", exitCode: 0, output: "你好，我是 Timo！" };
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

        const chatRunner = new MainChatRunner({ home, chatStore, chatBus, service, executors: registry, settingsStore });

        const greetRes = chatRunner.send({ text: "你好", executorId: "qwen-code" });
        assert.equal(greetRes.kind, "chat");
        await new Promise((r) => setTimeout(r, 40));
        assert.deepEqual(deltas, ["你好，", "我是 Timo！"]);
        assert.equal(frames.includes("chat_done"), true);
        assert.equal(service.listTasks(50, undefined, { archived: "all" }).length, 0, "casual chat MUST NOT create a task");
        assert.equal(service.listInbox().length, 0, "casual chat MUST NOT create an inbox item");

        // 2b. Read-only repo question stays in Main Chat with cwd set to that repo (ZERO worktree / task created!)
        const readOnlyRes = chatRunner.send({ text: "帮我看看 demo-app 仓库最新的进展", executorId: "qwen-code" });
        assert.equal(readOnlyRes.kind, "chat");
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(spawnCwds.at(-1), repoDir);
        assert.equal(service.listTasks(50, undefined, { archived: "all" }).length, 0, "read-only repo inquiry MUST NOT create a repo_delivery task");

        // 3. Explicit delivery intent delegates a background task and appends ONE task_card in Main Chat
        const workRes = chatRunner.send({ text: "请帮我修复 demo-app 的超时逻辑", executorId: "qwen-code" });
        assert.equal(workRes.kind, "task");
        assert.equal(service.listTasks(50, undefined, { archived: "all" }).length, 1);
        const history = chatStore.list(50);
        assert.equal(history.filter((m) => m.role === "task_card").length, 1);
      } finally {
        service.close();
      }
    });
  });
});
