import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HandoffRepo, HandoffSnapshot } from "./handoff.js";

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
    readonly code:
      | "base_ref_missing"
      | "repo_missing"
      | "not_a_repo"
      | "dirty_workspace"
      | "git_failed"
      | "exists"
      | "generation_missing"
      | "invalid_generation",
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
   * Immutable snapshot handoff `g1 → g2` (docs/architecture.md "不可变目录交接").
   *
   * Nothing mutable is reused: `g2` is a brand-new worktree, so a zombie
   * process still writing into `g1` cannot reach it. Uncommitted work is frozen
   * two ways — a patch (`diff HEAD`, staged + unstaged) that any executor can
   * review, and a byte-level materialization (overlay of `HEAD` plus the patch)
   * that preserves working-tree semantics without committing on the author's
   * behalf. Untracked files are copied raw. The returned snapshot carries
   * `baseSha` and `sourcePath` so `HandoffCapsule` survives restarts.
   */
  handoff(taskId: string, fromGeneration: number, toGeneration: number): HandoffSnapshot {
    if (!Number.isInteger(toGeneration) || toGeneration <= fromGeneration) {
      throw new WorkspaceError("invalid_generation", `handoff requires g${toGeneration} > g${fromGeneration}`);
    }
    const source = this.load(taskId, fromGeneration);
    if (!source) {
      throw new WorkspaceError("generation_missing", `workspace g${fromGeneration} for ${taskId} does not exist`);
    }
    const targetRoot = this.rootFor(taskId, toGeneration);
    if (existsSync(targetRoot)) {
      throw new WorkspaceError("exists", `workspace ${targetRoot} already exists`);
    }
    mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
    const prepared: PreparedRepo[] = [];
    const repos: HandoffRepo[] = [];
    try {
      for (const repo of source.repos) {
        // Freeze everything about the source repo before `g2` exists.
        const baseSha = repo.baseSha || this.headSha(repo.worktreePath);
        const headSha = this.headSha(repo.worktreePath);
        const diff = this.run(["diff", "HEAD"], repo.worktreePath);
        const diffStat = this.run(["diff", "--stat", "HEAD"], repo.worktreePath).trim();
        const untracked = this.freezeUntracked(repo.worktreePath);
        // Only the source's staged paths are restored in `g2`'s index; a plain
        // `add -A` would over-promote the unstaged edits.
        const stagedPaths = this.run(["diff", "--cached", "--name-only", "-z"], repo.worktreePath)
          .split("\0")
          .filter((path) => path !== "");

        const worktreePath = join(targetRoot, repo.name);
        const safeTask = taskId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32) || "task";
        const branch = `timo/${safeTask}/g${toGeneration}/${repo.name}`;
        this.run(["worktree", "add", "-b", branch, worktreePath, baseSha], repo.sourcePath);
        this.materializeOverlay(worktreePath, diff, stagedPaths, untracked);
        this.linkIgnoredNodeModules(repo.sourcePath, worktreePath);
        prepared.push({
          name: repo.name,
          sourcePath: repo.sourcePath,
          worktreePath,
          branch,
          baseRef: repo.baseRef,
          baseSha,
        });
        repos.push({
          name: repo.name,
          sourcePath: repo.sourcePath,
          baseSha,
          headSha,
          diffStat,
          diff,
          untracked,
          worktreePath,
          branch,
        });
      }
      const manifest: PreparedWorkspace = { taskId, generation: toGeneration, root: targetRoot, repos: prepared };
      writeFileSync(join(targetRoot, ".timo-workspace.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      return { taskId, fromGeneration, toGeneration, frozenAt: new Date().toISOString(), repos };
    } catch (error) {
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
      rmSync(targetRoot, { recursive: true, force: true });
      throw error instanceof WorkspaceError ? error : new WorkspaceError("git_failed", String(error));
    }
  }

  /** Snapshot of untracked (non-ignored) files as raw bytes, binary-safe. */
  private freezeUntracked(worktreePath: string): HandoffRepo["untracked"] {
    const listed = this.run(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath);
    return listed
      .split("\0")
      .filter((path) => path !== "")
      .map((path) => {
        const absolute = join(worktreePath, path);
        const stat = statSync(absolute);
        if (!stat.isFile()) {
          throw new WorkspaceError("git_failed", `untracked entry ${path} is not a regular file`);
        }
        return { path, contentBase64: readFileSync(absolute).toString("base64"), size: stat.size };
      });
  }

  /**
   * Recreates the source working tree in the fresh checkout: applies the frozen
   * patch, restores the index so `git diff` still shows the same changes, and
   * writes the untracked bytes.
   */
  private materializeOverlay(
    worktreePath: string,
    diff: string,
    stagedPaths: string[],
    untracked: HandoffRepo["untracked"],
  ): void {
    if (diff !== "") {
      this.runWithInput(["apply", "--whitespace=nowarn", "-"], worktreePath, diff, false);
      // Deleted staged files must be staged as deletions too.
      if (stagedPaths.length > 0) {
        this.runWithInput(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], worktreePath, stagedPaths.join("\0"), false);
      }
    }
    for (const file of untracked) {
      const absolute = join(worktreePath, file.path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, Buffer.from(file.contentBase64, "base64"));
    }
  }

  /** Prepares a generation directory. All repos are validated before anything is
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
   * Runs git with `input` on stdin (patch application). The default `run` is
   * stdin-less by design, so this goes through `execFileSync` directly and keeps
   * the same clean environment.
   */
  private runWithInput(args: string[], cwd: string, input: string, ignoreFailure: boolean): void {
    try {
      execFileSync("git", args, { cwd, input, env: gitEnv(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      if (!ignoreFailure) throw new WorkspaceError("git_failed", `git ${args.join(" ")} failed: ${String(error)}`);
    }
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

/**
 * Clean git environment: deterministic identity and no interactive prompts, so
 * the user's own git config and hooks cannot interfere in a headless service.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Timo",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "timo@localhost",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Timo",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "timo@localhost",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Runs git with a clean environment so the user's local config cannot interfere. */
function defaultRun(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}
