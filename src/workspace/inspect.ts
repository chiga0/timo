import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface LocalPlatformAuthSnapshot {
  gitAvailable: boolean;
  gitCredentialHelper?: string;
  sshKeysCount: number;
  ghLoggedIn: boolean;
  ghSummary?: string;
  detectedRemoteHosts: string[];
}

export interface InspectedFolder {
  path: string;
  name: string;
  exists: boolean;
  isDirectory: boolean;
  kind: "git" | "docs";
  baseRef?: string;
  remoteHost?: string;
  remoteRepo?: string;
  detectedCheckCommand?: string;
}

/**
 * Parses SSH (`git@host:group/repo.git`) or HTTPS (`https://host/group/repo.git`)
 * Git remote URLs into `{ host, repo }` without leaking any embedded credentials.
 */
export function parseGitRemote(rawUrl: string): { host?: string; repo?: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) return {};
  // SSH SCP-like syntax: git@code.example.com:group/sub/repo.git
  const scp = trimmed.match(/^(?:[^@]+@)?([^:/]+):(.+?)(?:\.git)?$/);
  if (scp && !trimmed.includes("://")) {
    return { host: scp[1], repo: scp[2]?.replace(/^\/+/, "") };
  }
  try {
    const parsed = new URL(trimmed);
    const repo = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    return { host: parsed.hostname || undefined, repo: repo || undefined };
  } catch {
    return {};
  }
}

/**
 * Automatically inspects a local folder to determine whether it is a Git repo
 * or a plain docs/knowledge directory, and extracts branch, remote, and a
 * sensible default test/check command with zero manual form entry.
 */
export function inspectLocalFolder(folderPath: string): InspectedFolder {
  const normalized = folderPath.trim().replace(/\/+$/, "") || folderPath.trim();
  const name = basename(normalized) || normalized;
  if (!normalized || !existsSync(normalized)) {
    return { path: normalized, name, exists: false, isDirectory: false, kind: "docs" };
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(normalized).isDirectory();
  } catch {
    return { path: normalized, name, exists: false, isDirectory: false, kind: "docs" };
  }
  if (!isDirectory) {
    return { path: normalized, name, exists: true, isDirectory: false, kind: "docs" };
  }

  const isGit = existsSync(join(normalized, ".git"));
  if (!isGit) {
    return { path: normalized, name, exists: true, isDirectory: true, kind: "docs" };
  }

  const baseRef = detectGitBranch(normalized) ?? "main";
  const remoteRaw = detectGitRemote(normalized);
  const remote = remoteRaw ? parseGitRemote(remoteRaw) : {};
  const detectedCheckCommand = detectCheckCommand(normalized);

  return {
    path: normalized,
    name,
    exists: true,
    isDirectory: true,
    kind: "git",
    baseRef,
    ...(remote.host ? { remoteHost: remote.host } : {}),
    ...(remote.repo ? { remoteRepo: remote.repo } : {}),
    ...(detectedCheckCommand ? { detectedCheckCommand } : {}),
  };
}

function detectGitBranch(dir: string): string | undefined {
  for (const args of [
    ["-C", dir, "symbolic-ref", "--short", "HEAD"],
    ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"],
  ]) {
    try {
      const out = execFileSync("git", args, { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (out && out !== "HEAD") return out;
    } catch {
      // try next strategy
    }
  }
  return undefined;
}

function gitRefExists(dir: string, ref: string): boolean {
  const clean = ref.trim();
  if (!clean) return false;
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `${clean}^{commit}`], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a valid baseRef for a registered local Git folder: prefers `preferredRef`
 * when it exists in the repository, otherwise falls back to the repository's live
 * checked-out branch so stale saved defaults (e.g. `main` on a `master` repo) never
 * fail worktree creation.
 */
export function resolveValidBaseRef(dir: string, preferredRef?: string): string {
  const preferred = preferredRef?.trim();
  if (preferred && gitRefExists(dir, preferred)) return preferred;
  const live = detectGitBranch(dir);
  if (live && gitRefExists(dir, live)) return live;
  for (const fallback of ["main", "master", "HEAD"]) {
    if (gitRefExists(dir, fallback)) return fallback;
  }
  return preferred || live || "main";
}

function detectGitRemote(dir: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function detectCheckCommand(dir: string): string | undefined {
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, unknown> };
      const scripts = pkg.scripts ?? {};
      const hasTypecheck = typeof scripts.typecheck === "string";
      const hasTest = typeof scripts.test === "string";
      if (hasTypecheck && hasTest) return "npm run typecheck && npm test";
      if (hasTest) return "npm test";
      if (typeof scripts.build === "string") return "npm run build";
    } catch {
      // ignore invalid package.json
    }
  }
  if (existsSync(join(dir, "go.mod"))) return "go test ./...";
  if (existsSync(join(dir, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "pytest.ini"))) return "pytest";
  if (existsSync(join(dir, "pom.xml"))) return "mvn test";
  return undefined;
}

/**
 * Opens the native OS folder picker dialog (Finder on macOS via `osascript`)
 * and returns the chosen absolute directory path, or `{ cancelled: true }`.
 */
export function pickNativeFolder(): Promise<{ cancelled: boolean; path?: string; error?: string }> {
  if (process.platform !== "darwin") {
    return Promise.resolve({ cancelled: true, error: "当前系统暂不支持原生弹窗选择，请手动输入目录路径。" });
  }
  return new Promise((resolve) => {
    const script = 'POSIX path of (choose folder with prompt "选择要加入 Timo 的本地目录")';
    execFile("osascript", ["-e", script], { timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        const msg = `${error.message} ${stderr ?? ""}`;
        if (/User canceled|-128/i.test(msg)) {
          resolve({ cancelled: true });
          return;
        }
        resolve({ cancelled: true, error: `无法打开目录选择器：${error.message}` });
        return;
      }
      const chosen = stdout.trim().replace(/\/+$/, "");
      if (!chosen) {
        resolve({ cancelled: true });
        return;
      }
      resolve({ cancelled: false, path: chosen });
    });
  });
}

/**
 * Probes non-secret local Git / SSH / `gh` authentication readiness so users
 * know Timo reuses their machine's existing Git auth without manual token setup.
 */
export function probeLocalPlatformAuth(
  folders: Array<{ remoteHost?: string }> = [],
  homeDir = homedir(),
): LocalPlatformAuthSnapshot {
  let gitAvailable = false;
  let gitCredentialHelper: string | undefined;
  try {
    execFileSync("git", ["--version"], { encoding: "utf8", timeout: 1_500, stdio: ["ignore", "pipe", "ignore"] });
    gitAvailable = true;
    const helper = execFileSync("git", ["config", "--get", "credential.helper"], {
      encoding: "utf8",
      timeout: 1_500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (helper) gitCredentialHelper = helper;
  } catch {
    // credential.helper may simply be unset
  }

  let sshKeysCount = 0;
  const sshDir = join(homeDir, ".ssh");
  if (existsSync(sshDir)) {
    try {
      const files = readdirSync(sshDir);
      sshKeysCount = files.filter((f) => f.endsWith(".pub")).length;
    } catch {
      // ignore unreadable .ssh
    }
  }

  let ghLoggedIn = false;
  let ghSummary: string | undefined;
  try {
    const out = execFileSync("gh", ["auth", "status"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    ghLoggedIn = /Logged in to/i.test(out);
    const match = out.match(/Logged in to\s+([^\s]+)(?:\s+account\s+([^\s(]+))?/i);
    if (match) {
      ghSummary = match[2] ? `${match[1]} (${match[2]})` : match[1];
    }
  } catch {
    // gh absent or not logged in
  }

  const detectedRemoteHosts = [
    ...new Set(folders.map((f) => f.remoteHost?.trim()).filter((h): h is string => Boolean(h))),
  ].sort();

  return {
    gitAvailable,
    ...(gitCredentialHelper ? { gitCredentialHelper } : {}),
    sshKeysCount,
    ghLoggedIn,
    ...(ghSummary ? { ghSummary } : {}),
    detectedRemoteHosts,
  };
}

const SCAN_IGNORED = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage", ".venv", "__pycache__", "target"]);

/**
 * Recursively discovers Git repositories (without descending inside a repo) and
 * top-level doc directories under a user-chosen parent folder.
 */
export function scanWorkspaceRoot(rootPath: string, maxDepth = 2, limit = 40): InspectedFolder[] {
  const normalized = rootPath.trim().replace(/\/+$/, "");
  if (!normalized || !existsSync(normalized)) return [];
  const rootInfo = inspectLocalFolder(normalized);
  if (!rootInfo.exists || !rootInfo.isDirectory) return [];
  if (rootInfo.kind === "git") return [rootInfo];

  const found: InspectedFolder[] = [];
  const walk = (dir: string, depth: number) => {
    if (found.length >= limit || depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) break;
      if (!entry.isDirectory() || entry.name.startsWith(".") || SCAN_IGNORED.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const info = inspectLocalFolder(full);
      if (info.kind === "git") {
        found.push(info);
        continue; // Never descend inside a discovered Git repository.
      }
      if (depth < maxDepth) {
        walk(full, depth + 1);
      }
    }
  };
  walk(normalized, 1);
  return found;
}

/**
 * Automatically selects which Git folders from the workspace are explicitly
 * targeted by a user's natural-language request. Matches on identifier
 * boundaries so hyphenated skill/tool names like `data-agent-skill` never
 * falsely trigger the `data-agent` repository.
 */
export function selectFoldersForRequest<T extends { name: string; path: string; kind?: "git" | "docs"; remoteRepo?: string }>(
  requestText: string,
  folders: T[],
): T[] {
  const gitFolders = folders.filter((f) => f.kind === "git" || existsSync(join(f.path, ".git")));
  if (gitFolders.length === 0) return [];
  const lower = requestText.toLowerCase();
  return gitFolders.filter((f) => {
    const tokens = [f.name, f.remoteRepo ?? ""].map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2);
    return tokens.some((token) => containsIdentifierToken(lower, token));
  });
}

function containsIdentifierToken(haystack: string, token: string): boolean {
  const isIdentChar = (ch: string | undefined) => Boolean(ch && /[a-z0-9_-]/.test(ch));
  let from = 0;
  while (from <= haystack.length - token.length) {
    const idx = haystack.indexOf(token, from);
    if (idx === -1) return false;
    const before = idx > 0 ? haystack[idx - 1] : undefined;
    const after = idx + token.length < haystack.length ? haystack[idx + token.length] : undefined;
    if (!isIdentChar(before) && !isIdentChar(after)) return true;
    from = idx + 1;
  }
  return false;
}
