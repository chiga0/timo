import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Autonomous multi-repo worktrees. One task owns one generation directory with
 * zero, one or many repos, each checked out from a freshly created worktree so
 * the user's own working copy is never touched.
 *
 * Invariants enforced here (docs/technical-design.md "工作区管理"):
 * - the requested `baseRef` must exist; a missing branch is a hard error and
 *   never silently falls back to the default branch;
 * - the resolved `baseSha` is recorded per repo so a later candidate can be
 *   compared against the exact starting commit;
 * - teardown refuses to delete a directory that still holds dirty or untracked
 *   files unless the caller explicitly allows discarding them.
 */

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
  constructor(
    readonly code: "base_ref_missing" | "repo_missing" | "not_a_repo" | "dirty_workspace" | "git_failed" | "exists",
    message: string,
  ) {
    super(message);
  }
}

export interface RepoRequest {
  /** Absolute path to an existing clone of the repo. */
  sourcePath: string;
  /** Branch, tag or commit the worktree must start from. Required. */
  baseRef: string;
  /** Directory name under the generation; defaults to the source basename. */
  name?: string;
}

export interface PreparedRepo {
  name: string;
  sourcePath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  /** Exact commit the worktree was created at. */
  baseSha: string;
}

export interface PreparedWorkspace {
  taskId: string;
  generation: number;
  root: string;
  repos: PreparedRepo[];
}

export interface RepoStatus {
  name: string;
  worktreePath: string;
  headSha: string | null;
  branch: string | null;
  dirty: boolean;
  diffStat: string;
  untracked: string[];
}

export interface WorkspaceManagerOptions {
  /** Root under TIMO_HOME, e.g. `<home>/workspaces`. */
  home: string;
  /** Injected for tests so no real git is required by the caller. */
  run?: (args: string[], cwd: string) => string;
}

/**
 * Creates and inspects worktrees. Every git call goes through `run`, which is
 * synchronous and throws on a non-zero exit so failures cannot be swallowed.
 */
export class WorkspaceManager {
  private readonly run: (args: string[], cwd: string) => string;

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.run = options.run ?? defaultRun;
  }

  rootFor(taskId: string, generation = 1): string {
    return join(this.options.home, taskId, `g${generation}`);
  }

  /**
   * Prepares a generation directory. All repos are validated before anything is
   * created; if a later repo fails, the whole half-built directory is removed so
   * no partial workspace survives a rejected request.
   */
  prepare(taskId: string, repos: RepoRequest[], generation = 1): PreparedWorkspace {
    const root = this.rootFor(taskId, generation);
    if (existsSync(root)) {
      throw new WorkspaceError("exists", `workspace ${root} already exists`);
    }
    const resolved = repos.map((repo) => this.resolveRepo(repo));
    const names = new Set<string>();
    for (const repo of resolved) {
      if (names.has(repo.name)) {
        throw new WorkspaceError("exists", `duplicate repo name ${repo.name} in workspace ${taskId}`);
      }
      names.add(repo.name);
    }

    mkdirSync(root, { recursive: true, mode: 0o700 });
    const prepared: PreparedRepo[] = [];
    try {
      for (const repo of resolved) {
        const worktreePath = join(root, repo.name);
        const safeTask = taskId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32) || "task";
        const branch = `timo/${safeTask}/g${generation}/${repo.name}`;
        this.run(["worktree", "add", "-b", branch, worktreePath, repo.baseSha], repo.sourcePath);
        this.linkIgnoredNodeModules(repo.sourcePath, worktreePath);
        prepared.push({
          name: repo.name,
          sourcePath: repo.sourcePath,
          worktreePath,
          branch,
          baseRef: repo.baseRef,
          baseSha: repo.baseSha,
        });
      }
      const manifest: PreparedWorkspace = { taskId, generation, root, repos: prepared };
      writeFileSync(join(root, ".timo-workspace.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      return manifest;
    } catch (error) {
      // Roll back: prune worktrees and branches we created, then drop the directory.
      for (const repo of prepared) {
        try {
          this.run(["worktree", "remove", "--force", repo.worktreePath], repo.sourcePath);
        } catch {
          // best effort during failure cleanup
        }
        try {
          this.run(["branch", "-D", repo.branch], repo.sourcePath);
        } catch {
          // best effort during failure cleanup
        }
      }
      rmSync(root, { recursive: true, force: true });
      throw error instanceof WorkspaceError ? error : new WorkspaceError("git_failed", String(error));
    }
  }

  /**
   * Records the candidate head of one repo after the executor ran. Used to bind
   * verification to an exact commit.
   */
  headSha(worktreePath: string): string {
    return this.run(["rev-parse", "HEAD"], worktreePath).trim();
  }

  /** Read-only inspection: HEAD, dirty flag, diff summary, untracked files. */
  status(workspace: PreparedWorkspace): RepoStatus[] {
    return workspace.repos.map((repo) => {
      const headSha = safe(() => this.headSha(repo.worktreePath), null);
      const branch = safe(() => this.run(["rev-parse", "--abbrev-ref", "HEAD"], repo.worktreePath).trim(), null);
      // Porcelain gives untracked entries (`??`) alongside modifications.
      const porcelain = safe(() => this.run(["status", "--porcelain"], repo.worktreePath), "");
      const lines = porcelain.split("\n").filter((line) => line.trim() !== "");
      const untracked = lines.filter((line) => line.startsWith("??")).map((line) => line.slice(3).trim());
      const diffStat = safe(() => this.run(["diff", "--stat", "HEAD"], repo.worktreePath).trim(), "");
      return {
        name: repo.name,
        worktreePath: repo.worktreePath,
        headSha,
        branch,
        dirty: lines.length > 0,
        diffStat,
        untracked,
      };
    });
  }

  /**
   * Removes the generation directory. A dirty workspace is refused unless the
   * caller explicitly allows discarding it, because those files may be the only
   * copy of in-progress work.
   */
  teardown(taskId: string, generation = 1, options: { force?: boolean } = {}): { removed: boolean; reason?: string } {
    const root = this.rootFor(taskId, generation);
    if (!existsSync(root)) return { removed: false, reason: "not_found" };
    const workspace = this.load(taskId, generation);
    if (!options.force && workspace) {
      const dirty = this.status(workspace).filter((repo) => repo.dirty);
      if (dirty.length > 0) {
        const detail = dirty.map((repo) => `${repo.name}(${repo.untracked.length} untracked)`).join(", ");
        throw new WorkspaceError("dirty_workspace", `refusing to remove ${root}: dirty repos ${detail}`);
      }
    }
    if (workspace) {
      for (const repo of workspace.repos) {
        const sourcePath = repo.sourcePath || this.inferSourcePath(repo.worktreePath);
        if (sourcePath) {
          try {
            this.run(["worktree", "remove", "--force", repo.worktreePath], sourcePath);
          } catch {
            // The directory may already be gone; removal below is authoritative.
          }
          if (repo.branch && repo.branch.startsWith("timo/")) {
            try {
              this.run(["branch", "-D", repo.branch], sourcePath);
            } catch {
              // Branch may already be removed or checked out elsewhere.
            }
          }
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
    return { removed: true };
  }

  /**
   * Materializes a clean detached worktree for independent verification at an
   * exact candidate commit SHA. The author's worktree and the source repo's
   * working directory are never touched.
   */
  materializeCleanCheckout(sourcePath: string, sha: string, targetDir: string): string {
    if (!existsSync(sourcePath)) {
      throw new WorkspaceError("repo_missing", `repo ${sourcePath} does not exist`);
    }
    const verified = safe(() => this.run(["rev-parse", "--verify", `${sha}^{commit}`], sourcePath).trim(), null);
    if (!verified) {
      throw new WorkspaceError("base_ref_missing", `${sourcePath} has no commit ${sha}`);
    }
    mkdirSync(dirname(targetDir), { recursive: true, mode: 0o700 });
    this.run(["worktree", "add", "--detach", targetDir, verified], sourcePath);
    this.linkIgnoredNodeModules(sourcePath, targetDir);
    return targetDir;
  }

  /**
   * Symlinks `node_modules` from the source clone when it exists and is
   * gitignored, so Node/TS repos can run `npm test` inside fresh worktrees
   * without network installs or dirtying `git status`.
   */
  private linkIgnoredNodeModules(sourcePath: string, targetDir: string): void {
    const srcNm = join(sourcePath, "node_modules");
    const dstNm = join(targetDir, "node_modules");
    if (!existsSync(srcNm) || existsSync(dstNm)) return;
    const ignored = safe(() => {
      this.run(["check-ignore", "-q", "node_modules"], targetDir);
      return true;
    }, false);
    if (!ignored) return;
    try {
      symlinkSync(srcNm, dstNm, "dir");
    } catch {
      // Best-effort; if symlinking fails, repo commands fall back to repo setup.
    }
  }

  /** Removes a detached verification checkout created by `materializeCleanCheckout`. */
  cleanupCheckout(sourcePath: string, targetDir: string): void {
    if (sourcePath && existsSync(sourcePath)) {
      try {
        this.run(["worktree", "remove", "--force", targetDir], sourcePath);
      } catch {
        // Fallback to rmSync below.
      }
    }
    rmSync(targetDir, { recursive: true, force: true });
  }

  /**
   * Rebuilds the workspace record from disk. Reads the generation manifest
   * written by `prepare` so `sourcePath`, `baseRef`, and exact `baseSha` survive
   * restarts, falling back to scanning subdirectories when absent.
   */
  load(taskId: string, generation = 1): PreparedWorkspace | null {
    const root = this.rootFor(taskId, generation);
    if (!existsSync(root)) return null;
    const manifestPath = join(root, ".timo-workspace.json");
    if (existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as PreparedWorkspace;
        if (parsed && Array.isArray(parsed.repos)) return parsed;
      } catch {
        // Fall through to directory scan if manifest is damaged.
      }
    }
    const repos: PreparedRepo[] = [];
    for (const entry of readdirSync(root)) {
      if (entry.startsWith(".")) continue;
      const worktreePath = join(root, entry);
      if (!statSync(worktreePath).isDirectory()) continue;
      if (!existsSync(join(worktreePath, ".git"))) continue;
      const branch = safe(() => this.run(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath).trim(), null);
      const baseSha = safe(() => this.run(["rev-parse", "HEAD"], worktreePath).trim(), null);
      repos.push({
        name: entry,
        sourcePath: this.inferSourcePath(worktreePath) ?? "",
        worktreePath,
        branch: branch ?? "",
        baseRef: branch ?? "",
        baseSha: baseSha ?? "",
      });
    }
    return { taskId, generation, root, repos };
  }

  private inferSourcePath(worktreePath: string): string | null {
    const commonDir = safe(() => this.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktreePath).trim(), null);
    if (!commonDir) return null;
    return commonDir.endsWith("/.git") ? commonDir.slice(0, -5) : commonDir;
  }

  /**
   * Resolves a repo to an exact commit, refusing when the ref is absent. This is
   * the anti-fallback guard: no default branch is substituted.
   */
  private resolveRepo(repo: RepoRequest): { name: string; sourcePath: string; baseRef: string; baseSha: string } {
    if (!existsSync(repo.sourcePath) || !statSync(repo.sourcePath).isDirectory()) {
      throw new WorkspaceError("repo_missing", `repo ${repo.sourcePath} does not exist`);
    }
    try {
      this.run(["rev-parse", "--git-dir"], repo.sourcePath);
    } catch {
      throw new WorkspaceError("not_a_repo", `${repo.sourcePath} is not a git repository`);
    }
    const baseSha = safe(() => this.run(["rev-parse", "--verify", `${repo.baseRef}^{commit}`], repo.sourcePath).trim(), null);
    if (!baseSha) {
      throw new WorkspaceError("base_ref_missing", `${repo.sourcePath} has no ref ${repo.baseRef}; refusing to fall back to a default branch`);
    }
    return {
      name: repo.name ?? basename(repo.sourcePath),
      sourcePath: repo.sourcePath,
      baseRef: repo.baseRef,
      baseSha,
    };
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Runs git with a clean environment so the user's local config cannot interfere. */
function defaultRun(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      // Deterministic commits and no interactive prompts in a headless service.
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Timo",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "timo@localhost",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Timo",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "timo@localhost",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
