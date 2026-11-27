import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { T3RuntimeConfig } from "./config.js";
import { parsePolicy, type LoadedPolicy } from "./auth/policy.js";

/**
 * Optional non-secret T3 settings read from TIMO_HOME/t3.json (0600):
 * `{"url": "...", "projectId": "...", "providerId": "...", "model": "..."}`.
 * The token is never sourced from this file; it arrives through `TIMO_T3_TOKEN`
 * in the service environment, so it cannot leak through a config copy.
 */
export function readT3SettingsFile(home: string): Partial<Omit<T3RuntimeConfig, "token">> {
  const path = join(home, "t3.json");
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const value = parsed[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  const result: Partial<Omit<T3RuntimeConfig, "token">> = {};
  const url = pick("url");
  const projectId = pick("projectId");
  const providerId = pick("providerId");
  const model = pick("model");
  if (url) result.url = url;
  if (projectId) result.projectId = projectId;
  if (providerId) result.providerId = providerId;
  if (model) result.model = model;
  return result;
}

export function resolveT3Config(env: NodeJS.ProcessEnv, home: string): T3RuntimeConfig | null {
  const file = readT3SettingsFile(home);
  const url = env.TIMO_T3_URL?.trim() || file.url;
  const token = env.TIMO_T3_TOKEN?.trim();
  const projectId = env.TIMO_T3_PROJECT_ID?.trim() || file.projectId;
  const providerId = env.TIMO_T3_PROVIDER_ID?.trim() || file.providerId;
  const model = env.TIMO_T3_MODEL?.trim() || file.model;
  if (!url || !token || !projectId || !providerId || !model) return null;
  return { url, token, projectId, providerId, model };
}

/**
 * Loads `TIMO_HOME/policy.json` if present. A file that exists but cannot be
 * parsed is reported as a warning and the safe defaults apply — a broken policy
 * file must never silently widen the delegation.
 */
export function loadPolicyFile(home: string): LoadedPolicy {
  const path = join(home, "policy.json");
  if (!existsSync(path)) return parsePolicy(undefined);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      policy: parsePolicy(undefined).policy,
      source: "default",
      warning: `policy.json rejected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return parsePolicy(raw);
}

// ---------------------------------------------------------------------------
// Workspace, Assistant, Knowledge Base & Platform Connection Settings
// Persisted in TIMO_HOME/settings.json (non-secret) and TIMO_HOME/credentials.json (0600).
// Secrets are NEVER stored in settings.json or SQLite, and NEVER exposed to Workers.
// ---------------------------------------------------------------------------

export interface AssistantSettings {
  defaultExecutor: string;
  /** Per-executor optional model override, e.g. `{ "codex": "gpt-5.4" }`. */
  executorModels: Record<string, string>;
  /** Global custom prompt / team conventions injected when dispatching tasks. */
  systemPrompt: string;
  defaultMaxRepairRounds: number;
}

export type ConnectionKind = "github" | "enterprise_git" | "gitlab" | "log_service" | "service_registry";

export interface ProjectRepoConfig {
  id: string;
  name: string;
  localPath: string;
  baseRef: string;
  checkCommand: string;
  platformId?: string;
  remoteRepo?: string;
  description?: string;
}

export interface KnowledgeSourceConfig {
  id: string;
  name: string;
  path: string;
  /** `"global"` applies to all tasks, otherwise a `ProjectRepoConfig.id`. */
  scope: string;
  enabled: boolean;
  description?: string;
}

export interface PlatformConnectionConfig {
  id: string;
  name: string;
  kind: ConnectionKind;
  baseUrl: string;
  /** REST API prefix for enterprise Git / GitLab hosts, e.g. `/api/v4` or `/api/v3`. */
  apiPath?: string;
  /** Auth header name, e.g. `PRIVATE-TOKEN` or `Authorization`. */
  authHeader?: string;
  /** Logical key in credentials store or env, e.g. `ENTERPRISE_GIT_TOKEN`. */
  credentialKey: string;
  notes?: string;
}

/** Unified local folder entry (auto-detected as Git repo or docs/knowledge folder). */
export interface WorkspaceFolderConfig {
  id: string;
  name: string;
  path: string;
  kind?: "git" | "docs";
  baseRef?: string;
  checkCommand?: string;
  remoteHost?: string;
  remoteRepo?: string;
  description?: string;
}

export interface TimoUserSettings {
  version: 1;
  assistant: AssistantSettings;
  defaultProjectId: string | null;
  defaultFolderId?: string | null;
  folders?: WorkspaceFolderConfig[];
  /** Natural-language directory rules & operational conventions managed by Timo. */
  workspaceRules?: string;
  /** When true, Timo automatically cleans up clean worktrees of terminal tasks. */
  autoCleanupWorktrees?: boolean;
  projects: ProjectRepoConfig[];
  knowledge: KnowledgeSourceConfig[];
  connections: PlatformConnectionConfig[];
}

export interface CredentialStatus {
  key: string;
  configured: boolean;
  source: "env" | "file" | "unset";
}

export function defaultUserSettings(): TimoUserSettings {
  return {
    version: 1,
    assistant: {
      defaultExecutor: "qwen-code",
      executorModels: {},
      systemPrompt: "",
      defaultMaxRepairRounds: 2,
    },
    defaultProjectId: null,
    defaultFolderId: null,
    folders: [],
    workspaceRules: "",
    autoCleanupWorktrees: true,
    projects: [],
    knowledge: [],
    connections: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cleanString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function slugId(raw: string, fallbackPrefix: string, index: number): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `${fallbackPrefix}-${index + 1}`;
}

const VALID_CONNECTION_KINDS = new Set<ConnectionKind>([
  "github",
  "enterprise_git",
  "gitlab",
  "log_service",
  "service_registry",
]);

export function sanitizeUserSettings(raw: unknown): TimoUserSettings {
  const base = defaultUserSettings();
  const obj = asRecord(raw);
  const assistantRaw = asRecord(obj.assistant);
  const executorModelsRaw = asRecord(assistantRaw.executorModels);
  const executorModels: Record<string, string> = {};
  for (const [k, v] of Object.entries(executorModelsRaw)) {
    const key = k.trim();
    const val = cleanString(v);
    if (key && val) executorModels[key] = val;
  }
  const repairRoundsRaw = Number(assistantRaw.defaultMaxRepairRounds);
  const defaultMaxRepairRounds =
    Number.isInteger(repairRoundsRaw) && repairRoundsRaw >= 0 && repairRoundsRaw <= 6
      ? repairRoundsRaw
      : base.assistant.defaultMaxRepairRounds;

  const projectsRaw = Array.isArray(obj.projects) ? obj.projects : [];
  const seenProjects = new Set<string>();
  const projects: ProjectRepoConfig[] = [];
  projectsRaw.forEach((item, index) => {
    const rec = asRecord(item);
    const localPath = cleanString(rec.localPath);
    if (!localPath) return;
    const name = cleanString(rec.name) || basename(localPath) || `repo-${index + 1}`;
    let id = slugId(cleanString(rec.id) || name, "proj", index);
    while (seenProjects.has(id)) id = `${id}-${index + 1}`;
    seenProjects.add(id);
    const entry: ProjectRepoConfig = {
      id,
      name,
      localPath,
      baseRef: cleanString(rec.baseRef) || "main",
      checkCommand: cleanString(rec.checkCommand) || "npm run typecheck && npm test",
    };
    const platformId = cleanString(rec.platformId);
    const remoteRepo = cleanString(rec.remoteRepo);
    const description = cleanString(rec.description);
    if (platformId) entry.platformId = platformId;
    if (remoteRepo) entry.remoteRepo = remoteRepo;
    if (description) entry.description = description;
    projects.push(entry);
  });

  const knowledgeRaw = Array.isArray(obj.knowledge) ? obj.knowledge : [];
  const seenKnowledge = new Set<string>();
  const knowledge: KnowledgeSourceConfig[] = [];
  knowledgeRaw.forEach((item, index) => {
    const rec = asRecord(item);
    const path = cleanString(rec.path);
    if (!path) return;
    const name = cleanString(rec.name) || basename(path) || `kb-${index + 1}`;
    let id = slugId(cleanString(rec.id) || name, "kb", index);
    while (seenKnowledge.has(id)) id = `${id}-${index + 1}`;
    seenKnowledge.add(id);
    const scope = cleanString(rec.scope) || "global";
    const entry: KnowledgeSourceConfig = {
      id,
      name,
      path,
      scope: scope === "global" || seenProjects.has(scope) ? scope : "global",
      enabled: rec.enabled !== false,
    };
    const description = cleanString(rec.description);
    if (description) entry.description = description;
    knowledge.push(entry);
  });

  const connectionsRaw = Array.isArray(obj.connections) ? obj.connections : [];
  const seenConnections = new Set<string>();
  const connections: PlatformConnectionConfig[] = [];
  connectionsRaw.forEach((item, index) => {
    const rec = asRecord(item);
    const baseUrl = cleanString(rec.baseUrl).replace(/\/+$/, "");
    if (!baseUrl) return;
    const kindRaw = cleanString(rec.kind) as ConnectionKind;
    const kind: ConnectionKind = VALID_CONNECTION_KINDS.has(kindRaw) ? kindRaw : "enterprise_git";
    const name = cleanString(rec.name) || baseUrl;
    let id = slugId(cleanString(rec.id) || name, "conn", index);
    while (seenConnections.has(id)) id = `${id}-${index + 1}`;
    seenConnections.add(id);
    const entry: PlatformConnectionConfig = {
      id,
      name,
      kind,
      baseUrl,
      credentialKey: cleanString(rec.credentialKey) || `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TOKEN`,
    };
    const apiPath = cleanString(rec.apiPath);
    const authHeader = cleanString(rec.authHeader);
    const notes = cleanString(rec.notes);
    if (apiPath) entry.apiPath = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
    if (authHeader) entry.authHeader = authHeader;
    if (notes) entry.notes = notes;
    connections.push(entry);
  });

  const requestedDefault = cleanString(obj.defaultProjectId);
  const defaultProjectId =
    requestedDefault && seenProjects.has(requestedDefault) ? requestedDefault : projects[0]?.id ?? null;

  const foldersRaw = Array.isArray(obj.folders) ? obj.folders : [];
  const seenFolders = new Set<string>();
  const folders: WorkspaceFolderConfig[] = [];
  foldersRaw.forEach((item, index) => {
    const rec = asRecord(item);
    const path = cleanString(rec.path).replace(/\/+$/, "");
    if (!path) return;
    const name = cleanString(rec.name) || basename(path) || `folder-${index + 1}`;
    let id = slugId(cleanString(rec.id) || name, "dir", index);
    while (seenFolders.has(id)) id = `${id}-${index + 1}`;
    seenFolders.add(id);
    const kindRaw = cleanString(rec.kind);
    const entry: WorkspaceFolderConfig = {
      id,
      name,
      path,
      ...(kindRaw === "git" || kindRaw === "docs" ? { kind: kindRaw } : {}),
    };
    const baseRef = cleanString(rec.baseRef);
    const checkCommand = cleanString(rec.checkCommand);
    const remoteHost = cleanString(rec.remoteHost);
    const remoteRepo = cleanString(rec.remoteRepo);
    const description = cleanString(rec.description);
    if (baseRef) entry.baseRef = baseRef;
    if (checkCommand) entry.checkCommand = checkCommand;
    if (remoteHost) entry.remoteHost = remoteHost;
    if (remoteRepo) entry.remoteRepo = remoteRepo;
    if (description) entry.description = description;
    folders.push(entry);
  });

  // Backfill unified folders from any legacy projects / knowledge entries if folders wasn't populated yet.
  if (folders.length === 0 && (projects.length > 0 || knowledge.length > 0)) {
    for (const p of projects) {
      if (seenFolders.has(p.id)) continue;
      seenFolders.add(p.id);
      folders.push({
        id: p.id,
        name: p.name,
        path: p.localPath.replace(/\/+$/, ""),
        kind: "git",
        baseRef: p.baseRef,
        checkCommand: p.checkCommand,
        ...(p.remoteRepo ? { remoteRepo: p.remoteRepo } : {}),
        ...(p.description ? { description: p.description } : {}),
      });
    }
    for (const k of knowledge) {
      const normalized = k.path.replace(/\/+$/, "");
      if (folders.some((f) => f.path === normalized)) continue;
      let id = k.id;
      while (seenFolders.has(id)) id = `${id}-doc`;
      seenFolders.add(id);
      folders.push({
        id,
        name: k.name,
        path: normalized,
        kind: "docs",
        ...(k.description ? { description: k.description } : {}),
      });
    }
  }

  const requestedDefaultFolder = cleanString(obj.defaultFolderId);
  const defaultFolderId =
    requestedDefaultFolder && seenFolders.has(requestedDefaultFolder)
      ? requestedDefaultFolder
      : folders.find((f) => f.kind === "git")?.id ?? folders[0]?.id ?? null;

  return {
    version: 1,
    assistant: {
      defaultExecutor: cleanString(assistantRaw.defaultExecutor) || base.assistant.defaultExecutor,
      executorModels,
      systemPrompt: typeof assistantRaw.systemPrompt === "string" ? assistantRaw.systemPrompt.trim() : "",
      defaultMaxRepairRounds,
    },
    defaultProjectId,
    defaultFolderId,
    folders,
    workspaceRules: typeof obj.workspaceRules === "string" ? obj.workspaceRules.trim() : "",
    autoCleanupWorktrees: obj.autoCleanupWorktrees !== false,
    projects,
    knowledge,
    connections,
  };
}

function atomicWriteJson(filePath: string, data: unknown, mode = 0o600): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode });
  renameSync(tmp, filePath);
}

/**
 * Manages non-secret user settings (`TIMO_HOME/settings.json`) and isolated
 * gateway credentials (`TIMO_HOME/credentials.json`, mode 0600).
 */
export class SettingsStore {
  readonly settingsPath: string;
  readonly credentialsPath: string;

  constructor(
    readonly home: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.settingsPath = join(home, "settings.json");
    this.credentialsPath = join(home, "credentials.json");
  }

  load(): TimoUserSettings {
    if (!existsSync(this.settingsPath)) return defaultUserSettings();
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, "utf8")) as unknown;
      return sanitizeUserSettings(parsed);
    } catch {
      return defaultUserSettings();
    }
  }

  save(input: unknown): TimoUserSettings {
    const clean = sanitizeUserSettings(input);
    atomicWriteJson(this.settingsPath, clean, 0o600);
    return clean;
  }

  /** Reads raw credentials strictly inside the local service / MCP Gateway process. */
  private readCredentialFile(): Record<string, string> {
    if (!existsSync(this.credentialsPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.credentialsPath, "utf8")) as unknown;
      const obj = asRecord(parsed);
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) {
        const key = k.trim();
        if (key && typeof v === "string" && v.trim() !== "") {
          out[key] = v.trim();
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Resolves all gateway credentials (file + process env; env overrides file).
   * Must ONLY be passed to the local Capability MCP Gateway / PlatformAdapter.
   */
  resolveGatewayCredentials(): Record<string, string | undefined> {
    const fromFile = this.readCredentialFile();
    const merged: Record<string, string | undefined> = { ...fromFile };
    const settings = this.load();
    const knownKeys = new Set<string>([
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GITLAB_TOKEN",
      "ENTERPRISE_GIT_TOKEN",
      ...Object.keys(fromFile),
      ...settings.connections.map((c) => c.credentialKey).filter(Boolean),
    ]);
    for (const key of knownKeys) {
      const envVal = this.env[key]?.trim();
      if (envVal) merged[key] = envVal;
    }
    return merged;
  }

  /** Sets or clears one credential in `credentials.json` (0600). Never returns plaintext. */
  setCredential(keyRaw: string, valueRaw: string | null): CredentialStatus {
    const key = keyRaw.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{1,63}$/.test(key)) {
      throw new Error("credential key must match /^[A-Za-z_][A-Za-z0-9_.-]{1,63}$/");
    }
    const existing = this.readCredentialFile();
    const trimmed = typeof valueRaw === "string" ? valueRaw.trim() : "";
    if (trimmed === "") {
      delete existing[key];
    } else {
      existing[key] = trimmed;
    }
    atomicWriteJson(this.credentialsPath, existing, 0o600);
    return this.credentialStatus(key);
  }

  credentialStatus(key: string): CredentialStatus {
    const envVal = this.env[key]?.trim();
    if (envVal) return { key, configured: true, source: "env" };
    const fileMap = this.readCredentialFile();
    if (fileMap[key]) return { key, configured: true, source: "file" };
    return { key, configured: false, source: "unset" };
  }

  listCredentialStatuses(): CredentialStatus[] {
    const settings = this.load();
    const fileMap = this.readCredentialFile();
    const keys = new Set<string>([
      "GH_TOKEN",
      "ENTERPRISE_GIT_TOKEN",
      ...settings.connections.map((c) => c.credentialKey).filter(Boolean),
      ...Object.keys(fileMap),
    ]);
    return [...keys].sort().map((key) => this.credentialStatus(key));
  }

  /** Returns filesystem health checks for configured repos & knowledge sources (non-secret). */
  inspectPaths(settings = this.load()): {
    projects: Record<string, { exists: boolean; isGitRepo: boolean }>;
    knowledge: Record<string, { exists: boolean; kind: "file" | "dir" | "missing" }>;
  } {
    const projects: Record<string, { exists: boolean; isGitRepo: boolean }> = {};
    for (const project of settings.projects) {
      const exists = existsSync(project.localPath);
      const isGitRepo = exists && existsSync(join(project.localPath, ".git"));
      projects[project.id] = { exists, isGitRepo };
    }
    const knowledge: Record<string, { exists: boolean; kind: "file" | "dir" | "missing" }> = {};
    for (const source of settings.knowledge) {
      if (!existsSync(source.path)) {
        knowledge[source.id] = { exists: false, kind: "missing" };
        continue;
      }
      try {
        const st = statSync(source.path);
        knowledge[source.id] = { exists: true, kind: st.isDirectory() ? "dir" : "file" };
      } catch {
        knowledge[source.id] = { exists: false, kind: "missing" };
      }
    }
    return { projects, knowledge };
  }
}
