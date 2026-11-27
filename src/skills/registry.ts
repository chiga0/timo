import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { SkillConfigOverride, TimoUserSettings } from "../settings.js";
import { redactLogText } from "../platform/adapter.js";

/**
 * Timo Unified Skills Registry (executor-agnostic personal methodology layer).
 *
 * Skills are stored in `<TIMO_HOME>/skills/<id>/SKILL.md` using the industry-
 * standard YAML frontmatter (`name`, `description`, optional `scope`) + Markdown
 * body format. Users can also mount read-only external directories or import
 * existing skills from local agent runtimes (`~/.qwen/skills`, `~/.codex/skills`,
 * `~/.claude/skills`, etc.) so every executor (Qwen Code / Pi / Codex / OpenCode)
 * shares one consistent, user-owned Skill catalog.
 */

export type SkillScope = "global" | "chat" | "task" | `repo:${string}`;

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  scope: string;
  enabled: boolean;
  source: "managed" | "external";
  sourceLabel: string;
  filePath: string;
  /** Full markdown body (excluding YAML frontmatter), bounded for safety. */
  bodyPreview: string;
  updatedAt: string;
}

export interface ExternalSkillSource {
  id: string;
  label: string;
  path: string;
  skillCount: number;
  skills: Array<{ id: string; name: string; description: string; filePath: string }>;
}

const MAX_SKILL_BYTES = 64 * 1024;
const PREVIEW_BYTES = 1200;

export class SkillRegistry {
  constructor(
    private readonly home: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get managedDir(): string {
    return join(this.home, "skills");
  }

  /** Lists all managed + mounted external skills merged with user enable/scope overrides. */
  list(settings?: TimoUserSettings): SkillRecord[] {
    const configs: Record<string, SkillConfigOverride> = settings?.skillConfigs ?? {};
    const out: SkillRecord[] = [];
    const seenIds = new Set<string>();

    // 1. Timo-managed skills (`~/.timo/skills/*/SKILL.md`) take highest priority.
    for (const raw of scanSkillDir(this.managedDir, "managed", "Timo 托管")) {
      const override = configs[raw.id];
      out.push({
        ...raw,
        enabled: override?.enabled ?? true,
        scope: normalizeScope(override?.scope ?? raw.scope),
      });
      seenIds.add(raw.id);
    }

    // 2. Optional user-mounted read-only external skill directories.
    const extraDirs = settings?.skillDirs ?? [];
    for (const dir of extraDirs) {
      const cleanDir = dir.trim();
      if (!cleanDir || !existsSync(cleanDir)) continue;
      const label = `外部目录 (${basename(cleanDir) || cleanDir})`;
      for (const raw of scanSkillDir(cleanDir, "external", label)) {
        if (seenIds.has(raw.id)) continue;
        const override = configs[raw.id];
        out.push({
          ...raw,
          enabled: override?.enabled ?? true,
          scope: normalizeScope(override?.scope ?? raw.scope),
        });
        seenIds.add(raw.id);
      }
    }

    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Reads the full redacted Markdown content of a skill by id or name. */
  readFull(idOrName: string, settings?: TimoUserSettings): { skill: SkillRecord; body: string } | null {
    const needle = idOrName.trim().toLowerCase();
    if (!needle) return null;
    const all = this.list(settings);
    const match = all.find((s) => s.id.toLowerCase() === needle || s.name.toLowerCase() === needle);
    if (!match || !existsSync(match.filePath)) return null;
    try {
      const raw = readFileSync(match.filePath, "utf8").slice(0, MAX_SKILL_BYTES);
      const parsed = parseSkillMarkdown(raw, match.id);
      const safe = redactLogText(parsed.body);
      return { skill: match, body: safe.text.trim() };
    } catch {
      return null;
    }
  }

  /** Creates or updates a Timo-managed skill in `<TIMO_HOME>/skills/<slug>/SKILL.md`. */
  saveManaged(input: { id?: string; name: string; description: string; content: string; scope?: string }): SkillRecord {
    const name = input.name.trim();
    const description = input.description.trim();
    const body = input.content.trim();
    if (!name) throw new Error("skill name is required");
    if (!description) throw new Error("skill description is required");
    if (!body) throw new Error("skill content is required");

    const id = slugifySkillId(input.id?.trim() || name);
    const scope = normalizeScope(input.scope);
    const dir = resolve(this.managedDir, id);
    const base = resolve(this.managedDir);
    if (!dir.startsWith(`${base}/`) && dir !== base) {
      throw new Error("invalid skill id");
    }

    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filePath = join(dir, "SKILL.md");
    const serialized = serializeSkillMarkdown({ name, description, scope, body });
    writeFileSync(filePath, serialized, { encoding: "utf8", mode: 0o600 });

    const st = statSync(filePath);
    return {
      id,
      name,
      description,
      scope,
      enabled: true,
      source: "managed",
      sourceLabel: "Timo 托管",
      filePath,
      bodyPreview: body.slice(0, PREVIEW_BYTES),
      updatedAt: st.mtime.toISOString(),
    };
  }

  /** Deletes a Timo-managed skill directory. External mounted skills cannot be deleted here. */
  deleteManaged(id: string): boolean {
    const cleanId = slugifySkillId(id);
    const dir = resolve(this.managedDir, cleanId);
    const base = resolve(this.managedDir);
    if (!dir.startsWith(`${base}/`)) {
      throw new Error("invalid skill id");
    }
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** Discovers common local agent skill directories that exist on this machine. */
  discoverExternalSources(): ExternalSkillSource[] {
    const userHome = this.env.HOME || homedir();
    const candidates: Array<{ id: string; label: string; path: string }> = [
      { id: "qwen", label: "Qwen Code (~/.qwen/skills)", path: join(userHome, ".qwen", "skills") },
      { id: "codex", label: "Codex CLI (~/.codex/skills)", path: join(userHome, ".codex", "skills") },
      { id: "claude", label: "Claude Code (~/.claude/skills)", path: join(userHome, ".claude", "skills") },
      { id: "agents", label: "Shared Agents (~/.agents/skills)", path: join(userHome, ".agents", "skills") },
      { id: "pi", label: "Pi (~/.pi/agent/skills)", path: join(userHome, ".pi", "agent", "skills") },
    ];
    const results: ExternalSkillSource[] = [];
    for (const c of candidates) {
      if (!existsSync(c.path)) continue;
      const found = scanSkillDir(c.path, "external", c.label);
      if (found.length === 0) continue;
      results.push({
        id: c.id,
        label: c.label,
        path: c.path,
        skillCount: found.length,
        skills: found.map((s) => ({ id: s.id, name: s.name, description: s.description, filePath: s.filePath })),
      });
    }
    return results;
  }

  /** Imports skills (SKILL.md) from an external directory into `<TIMO_HOME>/skills/`. */
  importFromDir(
    sourceDir: string,
    options: { skillIds?: string[]; overwrite?: boolean } = {},
  ): { imported: string[]; skipped: string[] } {
    const resolvedSource = resolve(sourceDir.trim());
    if (!existsSync(resolvedSource)) {
      throw new Error(`source directory does not exist: ${sourceDir}`);
    }
    const found = scanSkillDir(resolvedSource, "external", "import");
    const allowSet =
      Array.isArray(options.skillIds) && options.skillIds.length > 0
        ? new Set(options.skillIds.map((s) => s.trim().toLowerCase()))
        : null;

    const imported: string[] = [];
    const skipped: string[] = [];
    for (const item of found) {
      if (allowSet && !allowSet.has(item.id.toLowerCase()) && !allowSet.has(item.name.toLowerCase())) {
        continue;
      }
      const targetDir = resolve(this.managedDir, item.id);
      const targetFile = join(targetDir, "SKILL.md");
      if (existsSync(targetFile) && !options.overwrite) {
        skipped.push(item.id);
        continue;
      }
      const raw = readFileSync(item.filePath, "utf8").slice(0, MAX_SKILL_BYTES);
      const parsed = parseSkillMarkdown(raw, item.id);
      const safeBody = redactLogText(parsed.body).text;
      this.saveManaged({
        id: item.id,
        name: parsed.name || item.name,
        description: parsed.description || item.description,
        content: safeBody || parsed.description || item.name,
        scope: parsed.scope || "global",
      });
      imported.push(item.id);
    }
    return { imported, skipped };
  }
}

/** Filters enabled skills applicable to the target surface (`chat` or `task`) and optional repo names. */
export function selectActiveSkills(
  skills: SkillRecord[],
  target: "chat" | "task",
  repoNames: string[] = [],
): SkillRecord[] {
  const repoSet = new Set(repoNames.map((r) => r.trim().toLowerCase()));
  return skills.filter((skill) => {
    if (!skill.enabled) return false;
    if (skill.scope === "global" || skill.scope === "") return true;
    if (skill.scope === target) return true;
    if (skill.scope.startsWith("repo:")) {
      const bound = skill.scope.slice("repo:".length).trim().toLowerCase();
      return bound !== "" && repoSet.has(bound);
    }
    return false;
  });
}

/**
 * Detects an explicit `/<skill-name>` prefix in user input (e.g. `/code-review ...`)
 * so Timo can inject the full SKILL.md body immediately regardless of which CLI runs.
 */
export function parseSlashSkillInvocation(
  text: string,
  skills: SkillRecord[],
): { skill: SkillRecord; remainingText: string } | null {
  const match = text.trim().match(/^\/([A-Za-z0-9._-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const token = match[1]!.toLowerCase();
  const matched = skills.find(
    (s) => s.enabled && (s.id.toLowerCase() === token || s.name.toLowerCase() === token),
  );
  if (!matched) return null;
  return { skill: matched, remainingText: (match[2] ?? "").trim() };
}

/** Progressive Disclosure catalog formatted for Main Chat or Background Worker prompts. */
export function formatSkillsPromptSection(skills: SkillRecord[], target: "chat" | "task"): string {
  if (skills.length === 0) {
    if (target === "chat") {
      return [
        "## Timo 托管统一 Skill 清单（跨执行器共享）",
        "当前 Timo 尚未配置托管 Skill（用户可在「设置 → Skills」创建，或一键从 ~/.qwen/skills、~/.codex/skills、~/.claude/skills 导入）。",
        "重要：当用户询问「我们有哪些可用的 skill / 技能」时，请明确区分并优先说明 Timo 托管 Skill 清单（当前为 0 个，可在设置页统一管理以跨执行器复用），不要把底层 CLI 私有扩展冒充为 Timo 统一托管 Skill。",
      ].join("\n");
    }
    return "";
  }
  const lines = skills.map(
    (s) =>
      `- \`/${s.id}\` **${s.name}** [${s.scope} · ${s.sourceLabel}]: ${s.description}（文件路径：\`${s.filePath}\`）`,
  );
  const header =
    target === "chat"
      ? [
          `## Timo 托管统一 Skill 清单（共 ${skills.length} 个已启用，跨所有执行器通用）`,
          "说明：这些 Skill 由 Timo 统一托管，切换 Qwen Code / Pi / Codex / OpenCode 均生效。当用户询问「有哪些可用 Skill」时，必须以本清单为主体回答（底层 CLI 自带扩展仅可作为次级补充说明）；当任务命中某个 Skill 时，请先通过 `timo_read_skill` 或只读读取对应 `SKILL.md` 文件遵循其中步骤。",
        ]
      : [
          `[Timo Managed Skills (${skills.length} enabled — read SKILL.md before applying)]`,
        ];
  return [...header, ...lines].join("\n");
}

function scanSkillDir(dir: string, source: "managed" | "external", sourceLabel: string): SkillRecord[] {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  const results: SkillRecord[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    let skillFile: string | null = null;
    let fallbackId = entry.name;

    if (entry.isDirectory()) {
      const candidate = join(full, "SKILL.md");
      if (existsSync(candidate)) {
        skillFile = candidate;
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name.toLowerCase() !== "readme.md") {
      skillFile = full;
      fallbackId = entry.name.replace(/\.md$/i, "");
    }

    if (!skillFile) continue;
    try {
      const st = statSync(skillFile);
      if (!st.isFile()) continue;
      const raw = readFileSync(skillFile, "utf8").slice(0, MAX_SKILL_BYTES);
      const parsed = parseSkillMarkdown(raw, fallbackId);
      const safeBody = redactLogText(parsed.body).text.trim();
      results.push({
        id: slugifySkillId(fallbackId),
        name: parsed.name || fallbackId,
        description: parsed.description || firstNonEmptyLine(safeBody) || fallbackId,
        scope: normalizeScope(parsed.scope),
        enabled: true,
        source,
        sourceLabel,
        filePath: skillFile,
        bodyPreview: safeBody.slice(0, PREVIEW_BYTES),
        updatedAt: st.mtime.toISOString(),
      });
    } catch {
      // Skip unreadable or broken skill files without failing the registry.
    }
  }
  return results;
}

export function parseSkillMarkdown(
  raw: string,
  fallbackName: string,
): { name: string; description: string; scope: string; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return {
      name: fallbackName,
      description: firstNonEmptyLine(normalized),
      scope: "global",
      body: normalized.trim(),
    };
  }
  const fmText = fmMatch[1] ?? "";
  const body = (fmMatch[2] ?? "").trim();
  const meta: Record<string, string> = {};
  for (const line of fmText.split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const val = kv[2]!.trim().replace(/^["']|["']$/g, "");
    meta[key] = val;
  }
  return {
    name: meta.name || fallbackName,
    description: meta.description || firstNonEmptyLine(body) || fallbackName,
    scope: meta.scope || "global",
    body,
  };
}

function serializeSkillMarkdown(input: { name: string; description: string; scope: string; body: string }): string {
  const escapeYaml = (v: string) => (/[:"'#\n]/.test(v) ? JSON.stringify(v) : v);
  return [
    "---",
    `name: ${escapeYaml(input.name)}`,
    `description: ${escapeYaml(input.description)}`,
    `scope: ${escapeYaml(input.scope)}`,
    "---",
    "",
    input.body.trim(),
    "",
  ].join("\n");
}

export function slugifySkillId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `skill-${Date.now()}`;
}

function normalizeScope(raw?: string): string {
  const v = (raw ?? "global").trim();
  if (v === "chat" || v === "task" || v === "global") return v;
  if (v.startsWith("repo:") && v.length > 5) return v;
  return "global";
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const cleaned = line.replace(/^#+\s*/, "").trim();
    if (cleaned) return cleaned.slice(0, 140);
  }
  return "";
}
