import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { KnowledgeSourceConfig, PlatformConnectionConfig, ProjectRepoConfig, TimoUserSettings } from "../settings.js";
import { redactLogText } from "../platform/adapter.js";

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini", ".conf", ".env.example"]);
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage", ".venv", "__pycache__"]);

export interface KnowledgeSnippet {
  sourceName: string;
  filePath: string;
  content: string;
  truncated: boolean;
}

export interface AssembledTaskContext {
  systemPrompt: string;
  projectSummary: string;
  serviceCatalog: string;
  knowledgeSnippets: KnowledgeSnippet[];
}

export interface AssembleOptions {
  maxTotalBytes?: number;
  maxFileBytes?: number;
  maxFilesPerSource?: number;
}

/**
 * Collects read-only assistant instructions, matched project metadata, logical
 * platform/service entries (never secret values!), and bounded local knowledge
 * files for a dispatched task.
 */
export function assembleTaskContext(
  settings: TimoUserSettings,
  repoPaths: string[],
  options: AssembleOptions = {},
): AssembledTaskContext {
  const maxTotalBytes = options.maxTotalBytes ?? 24 * 1024;
  const maxFileBytes = options.maxFileBytes ?? 6 * 1024;
  const maxFilesPerSource = options.maxFilesPerSource ?? 8;

  const normalizedPaths = new Set(repoPaths.map((p) => p.replace(/\/+$/, "")));
  const matchedProjects: ProjectRepoConfig[] = settings.projects.filter((project) =>
    normalizedPaths.has(project.localPath.replace(/\/+$/, "")),
  );
  const matchedProjectIds = new Set(matchedProjects.map((p) => p.id));

  const projectLines = matchedProjects.map((project) => {
    const platform = project.platformId ? settings.connections.find((c) => c.id === project.platformId) : undefined;
    const parts = [
      `name=${project.name}`,
      `baseRef=${project.baseRef}`,
      project.remoteRepo ? `remote=${project.remoteRepo}` : "",
      platform ? `platform=${platform.name} (${platform.baseUrl})` : "",
      project.description ? `desc=${project.description}` : "",
    ].filter(Boolean);
    return `- ${parts.join(" | ")}`;
  });

  // Only expose non-secret logical service/platform endpoints — NEVER credentials!
  const connectionLines = settings.connections.map((conn: PlatformConnectionConfig) => {
    const parts = [
      `[${conn.kind}] ${conn.name}`,
      `url=${conn.baseUrl}`,
      conn.notes ? `notes=${conn.notes}` : "",
    ].filter(Boolean);
    return `- ${parts.join(" | ")}`;
  });

  const relevantSources = settings.knowledge.filter(
    (source: KnowledgeSourceConfig) =>
      source.enabled && (source.scope === "global" || matchedProjectIds.has(source.scope)),
  );

  // Unified workspace folders: non-target folders serve automatically as
  // read-only workspace / knowledge context (doc folders inject bounded text;
  // companion Git folders expose their path & README reference).
  const unifiedFolders = settings.folders ?? [];
  const folderRefLines: string[] = [];
  if (settings.workspaceRules?.trim()) {
    folderRefLines.push(`[用户目录与操作规则]\n${settings.workspaceRules.trim()}`);
  }
  const extraDocSources: Array<{ name: string; path: string }> = [];
  for (const folder of unifiedFolders) {
    const cleanPath = folder.path.replace(/\/+$/, "");
    if (normalizedPaths.has(cleanPath)) continue;
    if (folder.kind === "git") {
      const parts = [
        `${folder.name} (${cleanPath})`,
        folder.remoteRepo ? `remote=${folder.remoteRepo}` : "",
        folder.description ? `desc=${folder.description}` : "",
      ].filter(Boolean);
      folderRefLines.push(`- [参考仓库] ${parts.join(" | ")}`);
    } else {
      folderRefLines.push(`- [文档目录] ${folder.name} (${cleanPath})${folder.description ? ` | ${folder.description}` : ""}`);
      if (!relevantSources.some((s) => s.path.replace(/\/+$/, "") === cleanPath)) {
        extraDocSources.push({ name: folder.name, path: cleanPath });
      }
    }
  }

  const snippets: KnowledgeSnippet[] = [];
  let remainingBytes = maxTotalBytes;

  for (const source of [...relevantSources.map((s) => ({ name: s.name, path: s.path })), ...extraDocSources]) {
    if (remainingBytes <= 256) break;
    const files = collectReadableFiles(source.path, maxFilesPerSource);
    for (const file of files) {
      if (remainingBytes <= 256) break;
      const cap = Math.min(maxFileBytes, remainingBytes);
      const loaded = readBoundedText(file, cap);
      if (!loaded) continue;
      const safe = redactLogText(loaded.text);
      const displayPath = file === source.path ? file : `${source.name}/${relative(source.path, file)}`;
      snippets.push({
        sourceName: source.name,
        filePath: displayPath,
        content: safe.text,
        truncated: loaded.truncated,
      });
      remainingBytes -= Buffer.byteLength(safe.text, "utf8");
    }
  }

  return {
    systemPrompt: settings.assistant.systemPrompt.trim(),
    projectSummary: [...projectLines, ...folderRefLines].join("\n"),
    serviceCatalog: connectionLines.join("\n"),
    knowledgeSnippets: snippets,
  };
}

/** Formats assembled context into a clean prompt prefix/block for an ExecutionAdapter. */
export function formatAssembledContext(context: AssembledTaskContext): string {
  const sections: string[] = [];
  if (context.systemPrompt) {
    sections.push(`[Assistant Instructions]\n${context.systemPrompt}`);
  }
  if (context.projectSummary) {
    sections.push(`[Registered Project Context]\n${context.projectSummary}`);
  }
  if (context.serviceCatalog) {
    sections.push(`[Configured Platforms & Services (Read-Only Reference, Credentials Isolated in Gateway)]\n${context.serviceCatalog}`);
  }
  if (context.knowledgeSnippets.length > 0) {
    const docs = context.knowledgeSnippets
      .map((s) => `### ${s.filePath}${s.truncated ? " (truncated)" : ""}\n${s.content}`)
      .join("\n\n");
    sections.push(`[Knowledge Base]\n${docs}`);
  }
  return sections.join("\n\n");
}

function collectReadableFiles(targetPath: string, limit: number): string[] {
  if (!existsSync(targetPath)) return [];
  let st;
  try {
    st = statSync(targetPath);
  } catch {
    return [];
  }
  if (st.isFile()) return [targetPath];
  if (!st.isDirectory()) return [];

  const results: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (results.length >= limit || depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (TEXT_EXTENSIONS.has(ext) || entry.name.toLowerCase() === "readme") {
          results.push(full);
        }
      }
    }
  };
  walk(targetPath, 0);
  return results;
}

function readBoundedText(filePath: string, maxBytes: number): { text: string; truncated: boolean } | null {
  try {
    const raw = readFileSync(filePath);
    // Skip binary files containing null bytes.
    if (raw.subarray(0, Math.min(raw.length, 512)).includes(0)) return null;
    const truncated = raw.byteLength > maxBytes;
    const text = raw.subarray(0, maxBytes).toString("utf8").trim();
    if (!text) return null;
    return { text, truncated };
  } catch {
    return null;
  }
}
