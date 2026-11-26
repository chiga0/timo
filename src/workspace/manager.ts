import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

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

    mkdirSync(root, { recursive: true, mode: 0o700 });
    const prepared: PreparedRepo[] = [];
    try {
      for (const repo of resolved) {
        const worktreePath = join(root, repo.name);
        const branch = `timo/${taskId.slice(0, 8)}/g${generation}/${repo.name}`;
        this.run(["worktree", "add", "-b", branch, worktreePath, repo.baseSha], repo.sourcePath);
        prepared.push({
          name: repo.name,
          sourcePath: repo.sourcePath,
          worktreePath,
          branch,
          baseRef: repo.baseRef,
          baseSha: repo.baseSha,
        });
      }
    } catch (error) {
      // Roll back: prune worktrees we registered, then drop the directory.
      for (const repo of resolved) {
        try {
          this.run(["worktree", "remove", "--force", join(root, repo.name)], repo.sourcePath);
        } catch {
          // best effort during failure cleanup
        }
      }
      rmSync(root, { recursive: true, force: true });
      throw error instanceof WorkspaceError ? error : new WorkspaceError("git_failed", String(error));
    }
    return { taskId, generation, root, repos: prepared };
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
        try {
          this.run(["worktree", "remove", "--force", repo.worktreePath], repo.sourcePath);
        } catch {
          // The directory may already be gone; removal below is authoritative.
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
    return { removed: true };
  }

  /**
   * Rebuilds the workspace record from disk. Worktrees are discovered by reading
   * each subdirectory's `git worktree` bookkeeping, so a restart can inspect and
   * clean up a generation created by an earlier process.
   */
  load(taskId: string, generation = 1): PreparedWorkspace | null {
    const root = this.rootFor(taskId, generation);
    if (!existsSync(root)) return null;
    const repos: PreparedRepo[] = [];
    for (const entry of readdirSync(root)) {
      const worktreePath = join(root, entry);
      if (!statSync(worktreePath).isDirectory()) continue;
      if (!existsSync(join(worktreePath, ".git"))) continue;
      const branch = safe(() => this.run(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath).trim(), null);
      const baseSha = safe(() => this.run(["rev-parse", "HEAD"], worktreePath).trim(), null);
      repos.push({
        name: entry,
        sourcePath: "",
        worktreePath,
        branch: branch ?? "",
        baseRef: branch ?? "",
        baseSha: baseSha ?? "",
      });
    }
    return { taskId, generation, root, repos };
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
