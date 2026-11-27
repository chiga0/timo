import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
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
  /** Markdown body (excluding YAML frontmatter), truncated to `PREVIEW_BYTES` for display only. */
  bodyPreview: string;
  updatedAt: string;
  /** Size of the full SKILL.md on disk; parse/import never truncate, only rendering does. */
  sizeBytes?: number;
  /** Non-fatal notices for this skill (e.g. oversized file, auxiliary files skipped). */
  warnings?: string[];
}

export interface ExternalSkillSource {
  id: string;
  label: string;
  path: string;
  skillCount: number;
  skills: Array<{ id: string; name: string; description: string; filePath: string }>;
}

/** Rendering-only cap: full content is always read for parsing/import/injection. */
const PREVIEW_BYTES = 1200;
/** Threshold above which a skill is flagged as "large" via `SkillRecord.warnings`. */
const LARGE_SKILL_BYTES = 64 * 1024;
/** Guard for auxiliary-file copy so a runaway import cannot walk an entire tree. */
const MAX_AUX_ENTRIES = 5000;
const FRONTMATTER_KNOWN_KEYS = new Set(["name", "description", "scope"]);

export interface ResyncEntry {
  skillId: string;
  status: "unchanged" | "updated" | "missing-source";
  sourcePath?: string;
  /** Auxiliary entries present in the source but absent in the managed copy. */
  added: string[];
  /** Auxiliary entries present in both source and managed copy whose content differs. */
  modified: string[];
  /** Auxiliary entries present in the managed copy but absent in the source. */
  removed: string[];
  bodyChanged?: boolean;
  frontmatterChanged?: boolean;
  warnings?: string[];
}

export interface ResyncReport {
  dryRun: boolean;
  unchanged: string[];
  updated: string[];
  missingSource: string[];
  entries: ResyncEntry[];
}

interface SourceHit {
  id: string;
  name: string;
  filePath: string;
  /** Directory holding SKILL.md (symlinks already resolved by scan). */
  dir: string;
  sourceDir: string;
}

interface AuxPlan {
  sourceEntries: string[];
  targetEntries: string[];
}

interface ImportTask {
  id: string;
  name: string;
  filePath: string;
  overwrite: boolean;
}

interface ImportResult {
  outcome: "imported" | "skipped";
  warnings: string[];
}

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
      const raw = readFileSync(match.filePath, "utf8");
      const parsed = parseSkillMarkdown(raw, match.id);
      const safe = redactLogText(parsed.body);
      return { skill: match, body: safe.text.trim() };
    } catch {
      return null;
    }
  }

  /** Creates or updates a Timo-managed skill in `<TIMO_HOME>/skills/<slug>/SKILL.md`. */
  saveManaged(input: {
    id?: string;
    name: string;
    description: string;
    content: string;
    scope?: string;
    /** Unknown frontmatter fields to preserve; `extraStyles` keeps their original YAML shape. */
    extras?: Record<string, string>;
    extraStyles?: Record<string, FrontmatterValue>;
  }): SkillRecord {
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
    if (!dir.startsWith(`${base}${sep}`) && dir !== base) {
      throw new Error("invalid skill id");
    }

    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filePath = join(dir, "SKILL.md");
    const serialized = serializeSkillMarkdown({
      name,
      description,
      scope,
      body,
      extras: input.extras,
      extraStyles: input.extraStyles,
    });
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
      sizeBytes: st.size,
    };
  }

  /** Deletes a Timo-managed skill directory. External mounted skills cannot be deleted here. */
  deleteManaged(id: string): boolean {
    const cleanId = slugifySkillId(id);
    const dir = resolve(this.managedDir, cleanId);
    const base = resolve(this.managedDir);
    if (!dir.startsWith(`${base}${sep}`)) {
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

  /** Imports skills (SKILL.md + auxiliary files) from an external directory into `<TIMO_HOME>/skills/`. */
  importFromDir(
    sourceDir: string,
    options: { skillIds?: string[]; overwrite?: boolean } = {},
  ): { imported: string[]; skipped: string[]; warnings: string[] } {
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
    const warnings: string[] = [];
    for (const item of found) {
      if (allowSet && !allowSet.has(item.id.toLowerCase()) && !allowSet.has(item.name.toLowerCase())) {
        continue;
      }
      const result = this.importOneSkill({
        id: item.id,
        name: item.name,
        filePath: item.filePath,
        overwrite: options.overwrite === true,
      });
      if (result.outcome === "skipped") skipped.push(item.id);
      else imported.push(item.id);
      warnings.push(...result.warnings);
    }
    return { imported, skipped, warnings };
  }

  /**
   * Searches across all discovered local agent skill directories (plus optional
   * extra dirs) and imports skills matching `skillIds` into `<TIMO_HOME>/skills/`.
   */
  importByNames(
    skillIds: string[],
    options: { overwrite?: boolean; extraDirs?: string[] } = {},
  ): { imported: string[]; skipped: string[]; notFound: string[]; matchedFrom: Record<string, string>; warnings: string[] } {
    const catalog = this.buildSourceCatalog(options.extraDirs ?? []);

    const imported: string[] = [];
    const skipped: string[] = [];
    const notFound: string[] = [];
    const matchedFrom: Record<string, string> = {};
    const warnings: string[] = [];
    const seenRequested = new Set<string>();

    for (const rawName of skillIds) {
      const needle = rawName.trim().toLowerCase();
      if (!needle || seenRequested.has(needle)) continue;
      seenRequested.add(needle);
      const hit = catalog.get(needle) ?? catalog.get(slugifySkillId(needle));
      if (!hit) {
        notFound.push(rawName.trim());
        continue;
      }
      const result = this.importOneSkill({
        id: hit.id,
        name: hit.name,
        filePath: hit.filePath,
        overwrite: options.overwrite === true,
      });
      matchedFrom[hit.id] = hit.sourceDir;
      if (result.outcome === "skipped") skipped.push(hit.id);
      else imported.push(hit.id);
      warnings.push(...result.warnings);
    }

    return { imported, skipped, notFound, matchedFrom, warnings };
  }

  /**
   * Re-syncs already-managed skills from their external sources (managed copies are
   * real copies, so upstream edits otherwise never reach `~/.timo/skills`).
   * `dryRun` returns the same diff summary without touching disk.
   */
  resyncManaged(options: { sourceDirs?: string[]; skillIds?: string[]; dryRun?: boolean } = {}): ResyncReport {
    const dryRun = options.dryRun === true;
    const sources = (options.sourceDirs ?? []).map((d) => d.trim()).filter((d) => d && existsSync(d));
    const catalog = this.buildSourceCatalog(sources);
    const wanted = Array.isArray(options.skillIds) && options.skillIds.length > 0
      ? new Set(options.skillIds.map((s) => s.trim().toLowerCase()).filter(Boolean))
      : null;

    const entries: ResyncEntry[] = [];
    for (const managed of scanSkillDir(this.managedDir, "managed", "Timo 托管")) {
      if (wanted && !wanted.has(managed.id.toLowerCase()) && !wanted.has(managed.name.toLowerCase())) continue;
      const source = catalog.get(managed.id.toLowerCase());
      const aux = source ? planAuxiliaryCopy(source.dir, managed.id, this.managedDir) : null;
      const entry = resyncEntryFor(managed, source, aux, this.managedDir);
      if (entry.status === "updated" && !dryRun && source) {
        const outcome = this.importOneSkill({
          id: managed.id,
          name: managed.name,
          filePath: source.filePath,
          overwrite: true,
        });
        const removeWarnings = removeStaleAuxiliaryFiles(
          resolve(this.managedDir, slugifySkillId(managed.id)),
          resolve(this.managedDir),
          entry.removed,
        );
        const warnings = [...outcome.warnings, ...removeWarnings];
        if (warnings.length > 0) entry.warnings = warnings;
      }
      entries.push(entry);
    }

    return {
      dryRun,
      unchanged: entries.filter((e) => e.status === "unchanged").map((e) => e.skillId),
      updated: entries.filter((e) => e.status === "updated").map((e) => e.skillId),
      missingSource: entries.filter((e) => e.status === "missing-source").map((e) => e.skillId),
      entries,
    };
  }

  /** Id/name → source location catalog across discovered agent dirs plus explicit extra dirs. */
  private buildSourceCatalog(extraDirs: string[]): Map<string, SourceHit> {
    const catalog = new Map<string, SourceHit>();
    const add = (item: { id: string; name: string; filePath: string }, sourceDir: string) => {
      const hit: SourceHit = { ...item, dir: dirname(item.filePath), sourceDir };
      if (!catalog.has(item.id.toLowerCase())) catalog.set(item.id.toLowerCase(), hit);
      if (!catalog.has(item.name.toLowerCase())) catalog.set(item.name.toLowerCase(), hit);
    };
    for (const src of this.discoverExternalSources()) {
      for (const item of src.skills) add(item, src.path);
    }
    for (const dir of extraDirs) {
      const clean = dir.trim();
      if (!clean || !existsSync(clean)) continue;
      for (const item of scanSkillDir(clean, "external", clean)) add(item, clean);
    }
    return catalog;
  }

  /** Shared copy routine: SKILL.md (redacted) + auxiliary files, or "skipped" when already present. */
  private importOneSkill(input: ImportTask): ImportResult {
    const base = resolve(this.managedDir);
    const targetDir = resolve(base, slugifySkillId(input.id));
    if (!isInside(targetDir, base)) return { outcome: "skipped", warnings: [] };
    const targetFile = join(targetDir, "SKILL.md");
    if (existsSync(targetFile) && !input.overwrite) return { outcome: "skipped", warnings: [] };

    // Full read on purpose: truncating here silently dropped the tail of large skills.
    const raw = readFileSync(input.filePath, "utf8");
    const parsed = parseSkillMarkdown(raw, input.id);
    const safeBody = redactLogText(parsed.body).text;
    this.saveManaged({
      id: input.id,
      name: parsed.name || input.name,
      description: parsed.description || input.name,
      content: safeBody || parsed.description || input.name,
      scope: parsed.scope || "global",
      extras: parsed.extraFields,
      extraStyles: parsed.extraFieldStyles,
    });

    // copyAuxiliaryFiles keeps every target inside the skill dir and re-checks the overwrite flag.
    const aux = copyAuxiliaryFiles(dirname(input.filePath), targetDir, base, { overwrite: input.overwrite });
    return { outcome: "imported", warnings: aux.warnings };
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

    // Follow symlinks cleanly: many agent runtimes symlink skill folders into ~/.qwen/skills etc.
    let entryStat;
    try {
      entryStat = statSync(full);
    } catch {
      continue;
    }

    if (entryStat.isDirectory()) {
      const candidate = join(full, "SKILL.md");
      if (existsSync(candidate)) {
        skillFile = candidate;
      }
    } else if (entryStat.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name.toLowerCase() !== "readme.md") {
      skillFile = full;
      fallbackId = entry.name.replace(/\.md$/i, "");
    }

    if (!skillFile) continue;
    try {
      const st = statSync(skillFile);
      if (!st.isFile()) continue;
      const raw = readFileSync(skillFile, "utf8");
      const parsed = parseSkillMarkdown(raw, fallbackId);
      const safeBody = redactLogText(parsed.body).text.trim();
      const warnings =
        st.size > LARGE_SKILL_BYTES
          ? [`SKILL.md 较大（${st.size} 字节）：全文已完整加载，列表仅展示前 ${PREVIEW_BYTES} 字符预览`]
          : [];
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
        sizeBytes: st.size,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch {
      // Skip unreadable or broken skill files without failing the registry.
    }
  }
  return results;
}

/**
 * Parsed frontmatter scalar. `text` is the decoded value (block scalars literal/folded
 * decoded); `rawStyle` keeps the original YAML form so unknown fields can round-trip
 * through `serializeSkillMarkdown` without being reformatted.
 */
interface FrontmatterValue {
  text: string;
  rawStyle: "plain" | "block" | "list";
  style?: "|" | ">";
  chomp?: "" | "-" | "+";
  blockLines?: string[];
  /** Raw `- item` lines when the value is a YAML sequence (e.g. `files:`). */
  listLines?: string[];
}

/** `key: value` mapping line this tiny parser understands (list items are ignored). */
const FRONTMATTER_KEY = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

export function parseSkillMarkdown(
  raw: string,
  fallbackName: string,
): {
  name: string;
  description: string;
  scope: string;
  body: string;
  /** Non-whitelisted frontmatter fields (`version`, `files`, `x-source`, ...) preserved verbatim. */
  extraFields: Record<string, string>;
  /** Raw YAML shape of the preserved fields so serialization can reproduce them exactly. */
  extraFieldStyles?: Record<string, FrontmatterValue>;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return {
      name: fallbackName,
      description: firstNonEmptyLine(normalized),
      scope: "global",
      body: normalized.trim(),
      extraFields: {},
    };
  }
  const fmLines = (fmMatch[1] ?? "").split("\n");
  const body = (fmMatch[2] ?? "").trim();
  const meta: Record<string, FrontmatterValue> = {};

  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i]!;
    const kv = line.match(FRONTMATTER_KEY);
    if (!kv) {
      i += 1;
      continue;
    }
    const key = kv[1]!.toLowerCase();
    const rawVal = kv[2]!.trim();

    // Support YAML block scalars: |, |-, |+, >, >-, >+
    const blockHeader = rawVal.match(/^([|>])([+-])?$/);
    if (blockHeader) {
      const style = blockHeader[1]! as "|" | ">";
      const chomp = (blockHeader[2] ?? "") as "" | "-" | "+";
      const blockLines: string[] = [];
      i += 1;
      while (i < fmLines.length) {
        const next = fmLines[i]!;
        if (next.trim() === "") {
          blockLines.push("");
          i += 1;
          continue;
        }
        // Indented continuation line belongs to this block; top-level line ends the block.
        if (/^[ \t]+/.test(next)) {
          blockLines.push(next);
          i += 1;
          continue;
        }
        break;
      }
      meta[key] = {
        text: decodeYamlBlockScalar(blockLines, style, chomp).trim(),
        rawStyle: "block",
        style,
        chomp,
        blockLines,
      };
      continue;
    }

    if (rawVal === "") {
      // `files:` followed by `- SKILL.md` items: keep the sequence verbatim so it round-trips.
      const listLines: string[] = [];
      let probe = i + 1;
      while (probe < fmLines.length && /^[ \t]*-[ \t]/.test(fmLines[probe]!)) {
        listLines.push(fmLines[probe]!);
        probe += 1;
      }
      if (listLines.length > 0) {
        meta[key] = {
          text: listLines.map((l) => l.replace(/^[ \t]*-[ \t]*/, "").trim()).join("\n"),
          rawStyle: "list",
          listLines,
        };
        i = probe;
        continue;
      }
    }

    meta[key] = { text: decodeYamlPlainScalar(rawVal), rawStyle: "plain" };
    i += 1;
  }

  const extraFields: Record<string, string> = {};
  const extraFieldStyles: Record<string, FrontmatterValue> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (FRONTMATTER_KNOWN_KEYS.has(key)) continue;
    extraFields[key] = value.text;
    extraFieldStyles[key] = value;
  }

  const nameText = meta.name?.text ?? "";
  const descriptionText = meta.description?.text ?? "";
  return {
    name: nameText || fallbackName,
    description: descriptionText || firstNonEmptyLine(body) || fallbackName,
    scope: meta.scope?.text || "global",
    body,
    extraFields,
    extraFieldStyles,
  };
}

/**
 * Re-emits an unknown frontmatter scalar. Block scalars keep their original
 * header + indented lines (round-trip exact); anything else goes through the
 * same double-quote style as the known fields.
 */
function serializeExtraField(key: string, value: FrontmatterValue | undefined, text: string): string[] {
  if (value?.rawStyle === "block" && Array.isArray(value.blockLines)) {
    return [`${key}: ${value.style}${value.chomp}`, ...value.blockLines];
  }
  if (value?.rawStyle === "list" && Array.isArray(value.listLines)) {
    return [`${key}:`, ...value.listLines];
  }
  // No original shape (e.g. caller-supplied extras): a JSON string literal is read back
  // identically by the parser, including embedded newlines.
  return [`${key}: ${escapeYaml(text)}`];
}

function decodeYamlBlockScalar(lines: string[], style: "|" | ">", chomp: "" | "-" | "+"): string {
  // Trim trailing blank lines unless chomp is "+"
  const work = [...lines];
  let trailingBlanks = 0;
  while (work.length > 0 && work[work.length - 1]!.trim() === "") {
    work.pop();
    trailingBlanks += 1;
  }
  if (work.length === 0) return "";

  let minIndent = Infinity;
  for (const l of work) {
    if (l.trim() === "") continue;
    const match = l.match(/^[ \t]*/);
    const len = match ? match[0].length : 0;
    if (len < minIndent) minIndent = len;
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;
  const stripped = work.map((l) => (l.trim() === "" ? "" : l.slice(minIndent)));

  let joined: string;
  if (style === "|") {
    joined = stripped.join("\n");
  } else {
    // Folded scalar (`>`): consecutive non-empty lines fold with a single space;
    // empty lines separate paragraphs with a newline.
    const out: string[] = [];
    for (let idx = 0; idx < stripped.length; idx += 1) {
      const cur = stripped[idx]!;
      if (cur === "") {
        out.push("\n");
      } else {
        if (out.length > 0 && out[out.length - 1] !== "\n") {
          out.push(" ");
        }
        out.push(cur);
      }
    }
    joined = out.join("");
  }

  if (chomp === "+") {
    return joined + "\n".repeat(trailingBlanks + 1);
  }
  if (chomp === "-") {
    return joined;
  }
  return joined;
}

function serializeSkillMarkdown(input: {
  name: string;
  description: string;
  scope: string;
  body: string;
  /** Unknown frontmatter fields to write back after the known ones (round-trip safe). */
  extras?: Record<string, string>;
  extraStyles?: Record<string, FrontmatterValue>;
}): string {
  const lines = [
    "---",
    `name: ${escapeYaml(input.name)}`,
    `description: ${escapeYaml(input.description)}`,
    `scope: ${escapeYaml(input.scope)}`,
  ];
  for (const [key, text] of Object.entries(input.extras ?? {})) {
    // Only emit keys the parser can read back; anything else would corrupt the file.
    if (!/^[A-Za-z0-9_-]+$/.test(key) || FRONTMATTER_KNOWN_KEYS.has(key.toLowerCase())) continue;
    lines.push(...serializeExtraField(key, input.extraStyles?.[key], text));
  }
  lines.push("---", "", input.body.trim(), "");
  return lines.join("\n");
}

function escapeYaml(v: string): string {
  return /[:"'#\n]/.test(v) ? JSON.stringify(v) : v;
}

/**
 * Reads back plain scalars produced by `escapeYaml`: double-quoted values are JSON
 * string literals (so embedded newlines survive), single/plain values pass through.
 */
function decodeYamlPlainScalar(rawVal: string): string {
  if (rawVal.length >= 2 && rawVal.startsWith('"') && rawVal.endsWith('"')) {
    try {
      return JSON.parse(rawVal);
    } catch {
      // Fall through: not a JSON literal (hand-written quoted YAML), strip quotes below.
    }
  }
  return rawVal.replace(/^["']|["']$/g, "");
}

/**
 * Copies a skill's auxiliary files/dirs (references/, scripts/, assets/, ...) next to
 * `<managedDir>/<id>/SKILL.md`. Text files are redacted; binary files are copied
 * byte-for-byte with a warning; executable bits are preserved. Every resolved target
 * must stay inside the skill directory (path-traversal guard).
 */
function copyAuxiliaryFiles(
  sourceDir: string,
  targetDir: string,
  managedBase: string,
  options: { overwrite: boolean },
): { copied: string[]; skipped: string[]; warnings: string[] } {
  const copied: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  if (!isInside(targetDir, managedBase)) {
    warnings.push(`目标目录越界，已跳过附属文件复制: ${targetDir}`);
    return { copied, skipped, warnings };
  }
  let budget = MAX_AUX_ENTRIES;

  const walk = (from: string, to: string, relative: string) => {
    let entries;
    try {
      entries = readdirSync(from, { withFileTypes: true });
    } catch {
      warnings.push(`无法读取源目录: ${relative || "."}`);
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (budget <= 0) {
        warnings.push(`附属文件数量超过上限 ${MAX_AUX_ENTRIES}，剩余未复制`);
        return;
      }
      budget -= 1;
      // SKILL.md 由 saveManaged 脱敏重写；隐藏态与依赖产物（.git / node_modules）不随迁。
      if ((relative === "" && entry.name === "SKILL.md") || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const sourcePath = join(from, entry.name);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const targetPath = resolve(to, entry.name);
      // 源为软链时其真实路径可能指向 skill 目录之外，一律不随迁（避免把外部目录整棵拷进来）。
      if (entry.isSymbolicLink() || !isSafeTarget(targetPath, targetDir)) {
        warnings.push(`路径穿越防护拦截: ${relativePath}`);
        skipped.push(relativePath);
        continue;
      }
      let st;
      try {
        st = statSync(sourcePath);
      } catch {
        warnings.push(`无法读取: ${relativePath}`);
        continue;
      }
      if (st.isDirectory()) {
        mkdirSync(targetPath, { recursive: true, mode: 0o700 });
        walk(sourcePath, targetPath, relativePath);
        continue;
      }
      if (!st.isFile()) continue;
      if (existsSync(targetPath) && !options.overwrite) {
        skipped.push(relativePath);
        continue;
      }
      const outcome = copyFileRedacted(sourcePath, targetPath, st.mode);
      copied.push(relativePath);
      if (outcome === "binary") {
        warnings.push(`二进制文件已原样复制（未脱敏）: ${relativePath}`);
      }
    }
  };

  walk(sourceDir, targetDir, "");
  return { copied, skipped, warnings };
}

type CopyFileOutcome = "text" | "binary";

/**
 * Writes a redacted copy when the file is valid UTF-8; copies binary files byte-for-byte.
 * Preserves the user-executable bit (0o700 vs 0o600) so helper scripts stay runnable.
 */
function copyFileRedacted(sourcePath: string, targetPath: string, sourceMode: number): CopyFileOutcome {
  const mode = (sourceMode & 0o111) !== 0 ? 0o700 : 0o600;
  const bytes = readFileSync(sourcePath);
  const text = bytes.toString("utf8");
  const isUtf8 = !text.includes("\uFFFD") && Buffer.from(text, "utf8").equals(bytes);
  if (!isUtf8) {
    copyFileSync(sourcePath, targetPath);
    try {
      chmodSync(targetPath, mode);
    } catch {
      // Best-effort permission normalization
    }
    return "binary";
  }
  writeFileSync(targetPath, redactLogText(text).text, { encoding: "utf8", mode });
  try {
    // writeFileSync mode only applies on file creation; ensure overwrite keeps executable bit.
    chmodSync(targetPath, mode);
  } catch {
    // Best-effort permission normalization
  }
  return "text";
}

/** Deletes upstream-removed auxiliary files inside `targetDir` and prunes empty parent subdirs. */
function removeStaleAuxiliaryFiles(targetDir: string, managedBase: string, removed: string[]): string[] {
  const warnings: string[] = [];
  if (removed.length === 0) return warnings;
  if (!isInside(targetDir, managedBase)) {
    warnings.push(`目标目录越界，已跳过清理已移除附属文件: ${targetDir}`);
    return warnings;
  }
  for (const rel of removed) {
    const targetPath = resolve(targetDir, rel);
    if (!isSafeTarget(targetPath, targetDir)) {
      warnings.push(`路径穿越防护拦截清理: ${rel}`);
      continue;
    }
    try {
      rmSync(targetPath, { force: true });
      // Prune empty intermediate subdirectories strictly inside targetDir.
      let parent = dirname(targetPath);
      while (parent !== targetDir && isInside(parent, targetDir)) {
        const remaining = readdirSync(parent);
        if (remaining.length > 0) break;
        rmdirSync(parent);
        parent = dirname(parent);
      }
    } catch {
      warnings.push(`无法清理已移除附属文件: ${rel}`);
    }
  }
  return warnings;
}

/** Lists non-symlink aux entries of a skill dir for resync diffing (matching copyAuxiliaryFiles). */
function listAuxiliaryEntries(dir: string): string[] {
  const out: string[] = [];
  const walk = (from: string, relative: string) => {
    let entries;
    try {
      entries = readdirSync(from, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (relative === "" && entry.name === "SKILL.md") continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) continue;
      const full = join(from, entry.name);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, relativePath);
      else if (st.isFile()) out.push(relativePath);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** Compares source vs managed copy auxiliary file lists. */
function planAuxiliaryCopy(sourceDir: string, skillId: string, managedDir: string): AuxPlan {
  const targetDir = resolve(managedDir, skillId);
  return {
    sourceEntries: listAuxiliaryEntries(sourceDir),
    targetEntries: existsSync(targetDir) ? listAuxiliaryEntries(targetDir) : [],
  };
}

function resyncEntryFor(
  managed: SkillRecord,
  source: SourceHit | undefined,
  aux: AuxPlan | null,
  managedDir: string,
): ResyncEntry {
  if (!source) {
    return { skillId: managed.id, status: "missing-source", added: [], modified: [], removed: [] };
  }
  const sourceEntries = aux?.sourceEntries ?? [];
  const targetEntries = aux?.targetEntries ?? [];
  const targetSet = new Set(targetEntries);
  const sourceSet = new Set(sourceEntries);
  const added = sourceEntries.filter((e) => !targetSet.has(e));
  const removed = targetEntries.filter((e) => !sourceSet.has(e));

  const targetDir = resolve(managedDir, slugifySkillId(managed.id));
  const modified: string[] = [];
  for (const rel of sourceEntries) {
    if (!targetSet.has(rel)) continue;
    if (auxFileChanged(join(source.dir, rel), join(targetDir, rel))) {
      modified.push(rel);
    }
  }

  const srcSkill = readNormalizedSkillForCompare(source.filePath, source.name);
  const dstSkill = readNormalizedSkillForCompare(managed.filePath, managed.name);
  const bodyChanged = srcSkill.body !== dstSkill.body;
  const frontmatterChanged = srcSkill.frontmatterKey !== dstSkill.frontmatterKey;

  if (!bodyChanged && !frontmatterChanged && added.length === 0 && modified.length === 0 && removed.length === 0) {
    return { skillId: managed.id, status: "unchanged", sourcePath: source.filePath, added, modified, removed };
  }
  return {
    skillId: managed.id,
    status: "updated",
    sourcePath: source.filePath,
    added,
    modified,
    removed,
    bodyChanged,
    frontmatterChanged,
  };
}

/** Compares source aux file (post-redaction for UTF-8 text, raw bytes for binary) against managed copy. */
function auxFileChanged(sourcePath: string, targetPath: string): boolean {
  try {
    const srcBytes = readFileSync(sourcePath);
    const dstBytes = readFileSync(targetPath);
    const srcText = srcBytes.toString("utf8");
    const isUtf8 = !srcText.includes("\uFFFD") && Buffer.from(srcText, "utf8").equals(srcBytes);
    if (!isUtf8) {
      return !srcBytes.equals(dstBytes);
    }
    return redactLogText(srcText).text !== dstBytes.toString("utf8");
  } catch {
    return true;
  }
}

/**
 * Normalized, post-redaction comparison of SKILL.md body and frontmatter so
 * redacted secrets or whitespace normalization never trigger false-positive resync loops.
 */
function readNormalizedSkillForCompare(
  filePath: string,
  fallbackName: string,
): { body: string; frontmatterKey: string } {
  try {
    const parsed = parseSkillMarkdown(readFileSync(filePath, "utf8"), fallbackName);
    const redactedBody = redactLogText(parsed.body).text.trim();
    const effectiveBody = redactedBody || (parsed.description || fallbackName).trim();
    const sortedExtras = Object.fromEntries(
      Object.entries(parsed.extraFields).sort(([a], [b]) => a.localeCompare(b)),
    );
    const frontmatterKey = JSON.stringify({
      name: parsed.name || fallbackName,
      description: parsed.description || fallbackName,
      scope: normalizeScope(parsed.scope),
      extras: sortedExtras,
    });
    return { body: effectiveBody, frontmatterKey };
  } catch {
    return { body: `\u0000unreadable:${filePath}`, frontmatterKey: `\u0000unreadable:${filePath}` };
  }
}

/** True when `target` is `base` itself or nested strictly below it (path-traversal guard). */
function isInside(target: string, base: string): boolean {
  const t = resolve(target);
  const b = resolve(base);
  return t === b || t.startsWith(`${b}${sep}`);
}

/**
 * Traversal guard for copy targets: resolves symlinks (realpath) so a link pointing
 * outside the skill dir cannot smuggle writes out, then re-checks the lexical form.
 */
function isSafeTarget(target: string, base: string): boolean {
  if (!isInside(target, base)) return false;
  const realBase = realpathSafe(base);
  const realParent = realpathSafe(dirname(target));
  if (!realBase || !realParent) return false;
  return isInside(realParent, realBase);
}

function realpathSafe(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
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
