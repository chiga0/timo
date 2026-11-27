import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defaultConfig } from "../src/config.js";
import { TaskService } from "../src/service/task-service.js";
import { SettingsStore } from "../src/settings.js";
import { SkillRegistry, parseSkillMarkdown } from "../src/skills/registry.js";
import { ChatStore, ChatStreamBus } from "../src/store/chat.js";
import { CapabilityMcpGateway } from "../src/gateway/mcp-gateway.js";
import { registerChiefTools } from "../src/gateway/chief-tools.js";
import { Router } from "../src/http/server.js";
import { registerApi } from "../src/http/routes.js";

async function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "timo-skills-sync-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes a skill dir with SKILL.md + auxiliary content under `root/<id>/`. */
function writeSkill(
  root: string,
  id: string,
  frontmatter: string[],
  body: string,
  aux: Record<string, string> = {},
): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), ["---", ...frontmatter, "---", "", body, ""].join("\n"), "utf8");
  for (const [rel, content] of Object.entries(aux)) {
    const target = join(dir, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return dir;
}

describe("Skill import: auxiliary files, full-size reads, frontmatter round-trip and resync", () => {
  it("copies references/scripts/assets subdirectories next to SKILL.md, redacts them, preserves executable bit and handles binaries", async () => {
    await withTempDir((dir) => {
      const home = join(dir, "home");
      const source = join(dir, "source-skills");
      const skillDir = writeSkill(
        source,
        "helper-pack",
        ["name: helper-pack", "description: 带附属目录的技能"],
        "按 references 执行。",
        {
          "references/change.md": "# 变更参考\n不要把 token=sk-live-secret-9999999999 打印出来",
          "scripts/run.sh": "#!/usr/bin/env bash\necho sk-live-secret-9999999999\n",
          "assets/logo.svg": "<svg/>",
          "templates/plan.md": "计划模板",
          "package.json": '{"name":"helper-pack"}',
        },
      );
      chmodSync(join(skillDir, "scripts", "run.sh"), 0o755);
      const binBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
      writeFileSync(join(skillDir, "assets", "icon.bin"), binBytes);
      // 一个指向 skill 目录外的软链，复制时必须被路径穿越防护拦下。
      const outside = join(dir, "outside-secret.md");
      writeFileSync(outside, "外部机密", "utf8");

      const registry = new SkillRegistry(home, {});
      const outcome = registry.importFromDir(source);
      assert.deepEqual(outcome.imported, ["helper-pack"]);
      assert.deepEqual(outcome.skipped, []);
      assert.ok(outcome.warnings.some((w) => w.includes("二进制文件已原样复制（未脱敏）: assets/icon.bin")));

      const managedDir = join(home, "skills", "helper-pack");
      assert.ok(existsSync(join(managedDir, "SKILL.md")));
      // 附属子目录与辅助文件全部随迁
      assert.ok(existsSync(join(managedDir, "references", "change.md")));
      assert.ok(existsSync(join(managedDir, "scripts", "run.sh")));
      assert.ok(existsSync(join(managedDir, "assets", "logo.svg")));
      assert.ok(existsSync(join(managedDir, "assets", "icon.bin")));
      assert.ok(existsSync(join(managedDir, "templates", "plan.md")));
      assert.ok(existsSync(join(managedDir, "package.json")));

      // 脚本保留用户可执行位，非脚本保持 0o600，二进制原样拷贝
      assert.ok((statSync(join(managedDir, "scripts", "run.sh")).mode & 0o100) !== 0, "scripts/run.sh should keep +x");
      assert.equal(statSync(join(managedDir, "references", "change.md")).mode & 0o111, 0);
      assert.ok(readFileSync(join(managedDir, "assets", "icon.bin")).equals(binBytes));

      // 附属文件同样脱敏
      const change = readFileSync(join(managedDir, "references", "change.md"), "utf8");
      assert.match(change, /变更参考/);
      assert.doesNotMatch(change, /sk-live-secret-9999999999/);
      assert.doesNotMatch(readFileSync(join(managedDir, "scripts", "run.sh"), "utf8"), /sk-live-secret-9999999999/);

      // 目标目录之外不留任何导出
      assert.equal(existsSync(join(dir, "skills")), false);

      // 已存在且 overwrite=false：整体跳过，不半覆盖
      writeFileSync(join(source, "helper-pack", "references", "change.md"), "# 改过的源", "utf8");
      const second = registry.importFromDir(source);
      assert.deepEqual(second.imported, []);
      assert.deepEqual(second.skipped, ["helper-pack"]);
      assert.match(readFileSync(join(managedDir, "references", "change.md"), "utf8"), /变更参考/);

      // overwrite=true 时同步覆盖附属文件并继续保留可执行位
      const third = registry.importFromDir(source, { overwrite: true });
      assert.deepEqual(third.imported, ["helper-pack"]);
      assert.match(readFileSync(join(managedDir, "references", "change.md"), "utf8"), /改过的源/);
      assert.ok((statSync(join(managedDir, "scripts", "run.sh")).mode & 0o100) !== 0);
    });
  });

  it("never writes auxiliary content outside the managed skill directory (path traversal guard)", async () => {
    await withTempDir((dir) => {
      const home = join(dir, "home");
      const source = join(dir, "source-skills");
      writeSkill(source, "evil", ["name: evil", "description: 恶意技能"], "正文");
      // 指向目录外的软链：文件本身可读，但解析后的目标路径会越界，必须被跳过并记 warning。
      const escapedTarget = join(dir, "outside-secret.md");
      writeFileSync(escapedTarget, "外部机密", "utf8");
      symlinkSync(escapedTarget, join(source, "evil", "references"));

      const registry = new SkillRegistry(home, {});
      const outcome = registry.importFromDir(source);
      assert.deepEqual(outcome.imported, ["evil"]);
      // 写入位置只可能落在 <home>/skills/evil/** 之内：越界软链被拒，不会污染外部
      assert.ok(existsSync(join(home, "skills", "evil", "SKILL.md")));
      assert.equal(existsSync(join(home, "skills", "evil", "references")), false);
      assert.equal(readFileSync(escapedTarget, "utf8"), "外部机密", "外部文件不得被改写");
      assert.ok(
        outcome.warnings.some((w) => w.includes("路径穿越防护拦截")),
        `expected traversal warning, got ${JSON.stringify(outcome.warnings)}`,
      );
    });
  });

  it("reads oversized SKILL.md in full (no 64KB silent truncation) while keeping the preview bounded", async () => {
    await withTempDir((dir) => {
      const home = join(dir, "home");
      const source = join(dir, "source-skills");
      const tail = "TAIL-MARKER-结尾必须保留";
      const filler = "填充说明行。\n".repeat(12000); // ~ 12k 行，远超 64KB
      writeSkill(source, "huge-skill", ["name: huge-skill", "description: 超大技能"], `${filler}${tail}`);

      const sourceSize = readFileSync(join(source, "huge-skill", "SKILL.md"), "utf8").length;
      assert.ok(sourceSize > 64 * 1024);

      const registry = new SkillRegistry(home, {});
      assert.deepEqual(registry.importFromDir(source).imported, ["huge-skill"]);

      // 导入后落盘的全文与源长度一致（尾部落盘）
      const managedRaw = readFileSync(join(home, "skills", "huge-skill", "SKILL.md"), "utf8");
      assert.ok(managedRaw.includes(tail));

      // readFull 返回完整正文（不截断）
      const full = registry.readFull("huge-skill");
      assert.ok(full);
      assert.ok(full.body.includes(tail));
      assert.ok(full.body.length > 64 * 1024);

      // 列表预览仍然限长，同时显式暴露大小与 warning，而不是静默丢数据
      const record = registry.list().find((s) => s.id === "huge-skill");
      assert.ok(record);
      assert.ok(record.bodyPreview.length <= 1200);
      assert.equal(record.sizeBytes, Buffer.byteLength(managedRaw, "utf8"));
      assert.ok(record.warnings && record.warnings.length > 0);
      assert.match(record.warnings![0]!, /全文已完整加载/);

      // 小技能不应产生 warning
      writeSkill(source, "small-skill", ["name: small-skill", "description: 小技能"], "短正文");
      registry.importFromDir(source, { skillIds: ["small-skill"] });
      const small = registry.list().find((s) => s.id === "small-skill");
      assert.equal(small?.warnings, undefined);
    });
  });

  it("preserves unknown frontmatter fields (version / files list / x-source) across read → serialize → read", async () => {
    await withTempDir((dir) => {
      const home = join(dir, "home");
      const source = join(dir, "source-skills");
      writeSkill(
        source,
        "demo-workflow",
        [
          "name: demo-workflow",
          "version: 0.0.3",
          "files:",
          "  - SKILL.md",
          "  - references",
          "x-source: custom-registry",
          "custom-block: |",
          "  第一行",
          "  第二行",
          "description: |",
          "  多行描述第一行",
          "  多行描述第二行",
        ],
        "按 references/cli.md 执行。",
      );

      const registry = new SkillRegistry(home, {});
      assert.deepEqual(registry.importFromDir(source).imported, ["demo-workflow"]);

      const written = readFileSync(join(home, "skills", "demo-workflow", "SKILL.md"), "utf8");
      const reparsed = parseSkillMarkdown(written, "demo-workflow");
      assert.equal(reparsed.extraFields.version, "0.0.3");
      assert.equal(reparsed.extraFields["x-source"], "custom-registry");
      assert.equal(reparsed.extraFields.files, "SKILL.md\nreferences");
      assert.equal(reparsed.extraFields["custom-block"], "第一行\n第二行");
      assert.equal(reparsed.name, "demo-workflow");
      assert.equal(reparsed.description, "多行描述第一行\n多行描述第二行");
      assert.equal(reparsed.body, "按 references/cli.md 执行。");

      // 再读一遍仍是同样结果（真正幂等 round-trip）
      const twice = parseSkillMarkdown(written, "demo-workflow");
      assert.deepEqual(twice.extraFields, reparsed.extraFields);

      // saveManaged 显式传入 extras 也能写回并被读回
      const saved = registry.saveManaged({
        id: "manual-extras",
        name: "manual-extras",
        description: "显式 extra",
        content: "正文",
        extras: { version: "1.2.3", "x-source": "manual", multiline: "行一\n行二" },
      });
      const manual = parseSkillMarkdown(readFileSync(saved.filePath, "utf8"), "manual-extras");
      assert.equal(manual.extraFields.version, "1.2.3");
      assert.equal(manual.extraFields["x-source"], "manual");
      assert.equal(manual.extraFields.multiline, "行一\n行二");
    });
  });

  it("resyncs managed copies from external sources (unchanged / updated / missing-source) and honours dryRun", async () => {
    await withTempDir((dir) => {
      const home = join(dir, "home");
      const fakeUserHome = join(dir, "user-home");
      const externalRoot = join(fakeUserHome, ".codex", "skills");
      writeSkill(externalRoot, "sync-me", ["name: sync-me", "version: 1.0.0"], "初版正文", {
        "references/a.md": "参考 A",
      });
      writeSkill(externalRoot, "stale-me", ["name: stale-me"], "初版正文", {});

      const registry = new SkillRegistry(home, { HOME: fakeUserHome });
      assert.deepEqual(registry.importByNames(["sync-me", "stale-me"]).imported, ["sync-me", "stale-me"]);

      // 1. 内容未变 -> unchanged
      const pristine = registry.resyncManaged({ dryRun: true });
      assert.deepEqual(pristine.unchanged.sort(), ["stale-me", "sync-me"]);
      assert.deepEqual(pristine.updated, []);
      assert.deepEqual(pristine.missingSource, []);

      // 2. 源正文与附属文件都变了 -> dryRun 只报告不写盘
      writeSkill(externalRoot, "sync-me", ["name: sync-me", "version: 2.0.0"], "第二版正文", {
        "references/a.md": "参考 A",
        "references/b.md": "新增参考 B",
      });
      const previewOnly = registry.resyncManaged({ dryRun: true });
      assert.equal(previewOnly.dryRun, true);
      assert.deepEqual(previewOnly.updated, ["sync-me"]);
      const previewEntry = previewOnly.entries.find((e) => e.skillId === "sync-me")!;
      assert.equal(previewEntry.status, "updated");
      assert.equal(previewEntry.bodyChanged, true);
      assert.deepEqual(previewEntry.added, ["references/b.md"]);
      assert.deepEqual(previewEntry.removed, []);
      // dryRun 未写入
      assert.match(readFileSync(join(home, "skills", "sync-me", "SKILL.md"), "utf8"), /初版正文/);
      assert.equal(existsSync(join(home, "skills", "sync-me", "references", "b.md")), false);

      // 3. 真实 resync 后副本与源一致，再跑一次回到 unchanged
      const applied = registry.resyncManaged({});
      assert.deepEqual(applied.updated, ["sync-me"]);
      const synced = readFileSync(join(home, "skills", "sync-me", "SKILL.md"), "utf8");
      assert.match(synced, /第二版正文/);
      assert.match(synced, /version: 2\.0\.0/);
      assert.equal(readFileSync(join(home, "skills", "sync-me", "references", "b.md"), "utf8"), "新增参考 B");
      assert.deepEqual(registry.resyncManaged({}).unchanged.sort(), ["stale-me", "sync-me"]);

      // 4. 仅修改附属文件内容 -> 检出 modified，resync 后同步并回到 unchanged
      writeFileSync(join(externalRoot, "sync-me", "references", "b.md"), "更新后的参考 B", "utf8");
      const auxEditPreview = registry.resyncManaged({ skillIds: ["sync-me"], dryRun: true });
      assert.deepEqual(auxEditPreview.updated, ["sync-me"]);
      assert.deepEqual(auxEditPreview.entries[0]!.modified, ["references/b.md"]);
      assert.equal(auxEditPreview.entries[0]!.bodyChanged, false);
      assert.equal(auxEditPreview.entries[0]!.frontmatterChanged, false);
      registry.resyncManaged({ skillIds: ["sync-me"] });
      assert.equal(readFileSync(join(home, "skills", "sync-me", "references", "b.md"), "utf8"), "更新后的参考 B");
      assert.deepEqual(registry.resyncManaged({ skillIds: ["sync-me"], dryRun: true }).unchanged, ["sync-me"]);

      // 5. 仅修改 frontmatter (version / description) -> 检出 frontmatterChanged，resync 后同步并回到 unchanged
      writeSkill(externalRoot, "sync-me", ["name: sync-me", "description: 更新后的描述", "version: 2.1.0"], "第二版正文", {
        "references/a.md": "参考 A",
        "references/b.md": "更新后的参考 B",
      });
      const fmPreview = registry.resyncManaged({ skillIds: ["sync-me"], dryRun: true });
      assert.deepEqual(fmPreview.updated, ["sync-me"]);
      assert.equal(fmPreview.entries[0]!.bodyChanged, false);
      assert.equal(fmPreview.entries[0]!.frontmatterChanged, true);
      registry.resyncManaged({ skillIds: ["sync-me"] });
      assert.match(readFileSync(join(home, "skills", "sync-me", "SKILL.md"), "utf8"), /version: 2\.1\.0/);
      assert.deepEqual(registry.resyncManaged({ skillIds: ["sync-me"], dryRun: true }).unchanged, ["sync-me"]);

      // 6. 上游删除附属文件 -> dryRun 报告 removed 但不删盘；真实 resync 删除托管副本里的过期文件并清理空目录
      rmSync(join(externalRoot, "sync-me", "references", "a.md"), { force: true });
      rmSync(join(externalRoot, "sync-me", "references", "b.md"), { force: true });
      const rmPreview = registry.resyncManaged({ skillIds: ["sync-me"], dryRun: true });
      assert.deepEqual(rmPreview.updated, ["sync-me"]);
      assert.deepEqual(rmPreview.entries[0]!.removed.sort(), ["references/a.md", "references/b.md"]);
      assert.ok(existsSync(join(home, "skills", "sync-me", "references", "a.md")));
      registry.resyncManaged({ skillIds: ["sync-me"] });
      assert.equal(existsSync(join(home, "skills", "sync-me", "references", "a.md")), false);
      assert.equal(existsSync(join(home, "skills", "sync-me", "references", "b.md")), false);
      assert.equal(existsSync(join(home, "skills", "sync-me", "references")), false, "empty subdir should be pruned");
      assert.deepEqual(registry.resyncManaged({ skillIds: ["sync-me"], dryRun: true }).unchanged, ["sync-me"]);

      // 7. 含脱敏密钥的源技能导入后再 resync -> 必须判定为 unchanged，不产生永久误报
      writeSkill(
        externalRoot,
        "redacted-skill",
        ["name: redacted-skill", "description: 含脱敏内容"],
        "示例 token=sk-live-secret-9999999999 不可泄露",
        { "references/note.md": "api_key=sk-live-secret-8888888888" },
      );
      assert.deepEqual(registry.importByNames(["redacted-skill"]).imported, ["redacted-skill"]);
      const redactedCheck = registry.resyncManaged({ skillIds: ["redacted-skill"], dryRun: true });
      assert.deepEqual(redactedCheck.unchanged, ["redacted-skill"]);
      assert.deepEqual(redactedCheck.updated, []);

      // 8. 源被删除 -> missing-source
      rmSync(join(externalRoot, "stale-me"), { recursive: true, force: true });
      const afterDelete = registry.resyncManaged({ dryRun: true });
      assert.deepEqual(afterDelete.missingSource, ["stale-me"]);
      assert.ok(existsSync(join(home, "skills", "stale-me", "SKILL.md")), "missing-source 不删除托管副本");

      // 9. skillIds 过滤
      const filtered = registry.resyncManaged({ skillIds: ["sync-me"], dryRun: true });
      assert.deepEqual(filtered.entries.map((e) => e.skillId), ["sync-me"]);
    });
  });

  it("exposes resync via Chief MCP timo_resync_skills and the /api/skills/resync REST route", async () => {
    await withTempDir(async (dir) => {
      const home = join(dir, "home");
      const fakeUserHome = join(dir, "user-home");
      const externalRoot = join(fakeUserHome, ".qwen", "skills");
      writeSkill(externalRoot, "mcp-skill", ["name: mcp-skill", "description: MCP 同步技能"], "初版", {
        "references/x.md": "X",
      });

      const registry = new SkillRegistry(home, { HOME: fakeUserHome });
      assert.deepEqual(registry.importByNames(["mcp-skill"]).imported, ["mcp-skill"]);
      writeSkill(externalRoot, "mcp-skill", ["name: mcp-skill", "description: MCP 同步技能"], "第二版", {
        "references/x.md": "X",
      });

      const { service, db, bus, writer } = TaskService.open(defaultConfig({}, home));
      const settingsStore = new SettingsStore(home, {});
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
        const client = new McpClient({ name: "resync-test", version: "1.0.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(chief.url)));

        const dryRes = await client.callTool({ name: "timo_resync_skills", arguments: { dryRun: true } });
        const dryJson = JSON.parse((dryRes.content as Array<{ text: string }>)[0]!.text) as {
          dryRun: boolean;
          updated: string[];
        };
        assert.equal(dryJson.dryRun, true);
        assert.deepEqual(dryJson.updated, ["mcp-skill"]);
        assert.match(readFileSync(join(home, "skills", "mcp-skill", "SKILL.md"), "utf8"), /初版/);

        const realRes = await client.callTool({ name: "timo_resync_skills", arguments: {} });
        const realJson = JSON.parse((realRes.content as Array<{ text: string }>)[0]!.text) as { updated: string[] };
        assert.deepEqual(realJson.updated, ["mcp-skill"]);
        assert.match(readFileSync(join(home, "skills", "mcp-skill", "SKILL.md"), "utf8"), /第二版/);
        await client.close();
        gateway.revokeChief(chief.nonce);
      } finally {
        await gateway.close();
      }

      // REST 路由同样是 dryRun 只读、非 dryRun 落盘
      writeSkill(externalRoot, "mcp-skill", ["name: mcp-skill", "description: MCP 同步技能"], "第三版", {
        "references/x.md": "X",
      });
      const router = new Router();
      registerApi(router, {
        service,
        ledger: writer.ledger,
        bus,
        startedAt: new Date().toISOString(),
        t3Configured: false,
        settingsStore,
        skillRegistry: registry,
      });
      const callApi = async (method: string, path: string, body?: unknown) => {
        const match = await router.dispatch({
          method,
          path,
          query: new URLSearchParams(),
          params: {},
          body,
          accept: "application/json",
          trustedLocal: true,
        });
        assert.ok(match);
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
      try {
        const dryRoute = await callApi("POST", "/api/skills/resync", { dryRun: true });
        assert.deepEqual((dryRoute.body as { updated: string[] }).updated, ["mcp-skill"]);
        assert.match(readFileSync(join(home, "skills", "mcp-skill", "SKILL.md"), "utf8"), /第二版/);
        const realRoute = await callApi("POST", "/api/skills/resync", {});
        assert.deepEqual((realRoute.body as { updated: string[] }).updated, ["mcp-skill"]);
        assert.match(readFileSync(join(home, "skills", "mcp-skill", "SKILL.md"), "utf8"), /第三版/);
      } finally {
        service.close();
      }
    });
  });

});
