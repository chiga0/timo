import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceError, WorkspaceManager } from "../src/workspace/manager.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
};

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

/** Creates a repo with one commit on `main` plus a `feature` branch. */
function makeRepo(root: string, name: string): string {
  const path = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", path], { env: GIT_ENV });
  writeFileSync(join(path, "readme.txt"), `${name}\n`);
  git(["add", "."], path);
  git(["commit", "-qm", "init"], path);
  git(["branch", "feature"], path);
  return path;
}

interface Fixture {
  root: string;
  workspaceHome: string;
  repoA: string;
  repoB: string;
  manager: WorkspaceManager;
  dispose: () => void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "timo-ws-"));
  const workspaceHome = join(root, "workspaces");
  const repoA = makeRepo(root, "repo-a");
  const repoB = makeRepo(root, "repo-b");
  return {
    root,
    workspaceHome,
    repoA,
    repoB,
    manager: new WorkspaceManager({ home: workspaceHome }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a multi-repo generation records the exact baseSha for every repo", () => {
  const f = fixture();
  try {
    const expectedA = git(["rev-parse", "HEAD"], f.repoA);
    const expectedB = git(["rev-parse", "HEAD"], f.repoB);
    const workspace = f.manager.prepare("task-multi", [
      { sourcePath: f.repoA, baseRef: "main" },
      { sourcePath: f.repoB, baseRef: "feature" },
    ]);

    assert.equal(workspace.repos.length, 2);
    assert.equal(workspace.repos[0]!.baseSha, expectedA);
    assert.equal(workspace.repos[1]!.baseSha, expectedB);
    for (const repo of workspace.repos) {
      assert.ok(existsSync(repo.worktreePath));
      assert.equal(git(["rev-parse", "HEAD"], repo.worktreePath), repo.baseSha);
      assert.match(repo.branch, /^timo\/task-mul\/g1\//);
    }
    // The generation lives under <home>/<taskId>/g1/<repo>.
    assert.equal(workspace.root, join(f.workspaceHome, "task-multi", "g1"));
  } finally {
    f.dispose();
  }
});

test("two concurrent tasks get independent worktrees and leave the source repo clean", () => {
  const f = fixture();
  try {
    const cleanBefore = git(["status", "--porcelain"], f.repoA);
    const one = f.manager.prepare("task-one", [{ sourcePath: f.repoA, baseRef: "main" }]);
    const two = f.manager.prepare("task-two", [{ sourcePath: f.repoA, baseRef: "main" }]);

    assert.notEqual(one.repos[0]!.worktreePath, two.repos[0]!.worktreePath);
    assert.notEqual(one.repos[0]!.branch, two.repos[0]!.branch);

    // Writing in one worktree must not be visible in the other or in the source.
    writeFileSync(join(one.repos[0]!.worktreePath, "only-one.txt"), "x\n");
    assert.equal(existsSync(join(two.repos[0]!.worktreePath, "only-one.txt")), false);
    assert.equal(existsSync(join(f.repoA, "only-one.txt")), false);

    // The user's own working copy stays untouched throughout.
    assert.equal(git(["status", "--porcelain"], f.repoA), cleanBefore);
    assert.deepEqual(f.manager.status(one)[0]!.untracked, ["only-one.txt"]);
  } finally {
    f.dispose();
  }
});

test("a missing baseRef in the second repo rejects the whole request and cleans up", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.manager.prepare("task-bad", [
          { sourcePath: f.repoA, baseRef: "main" },
          { sourcePath: f.repoB, baseRef: "does-not-exist" },
        ]),
      (error: Error) => error instanceof WorkspaceError && error.code === "base_ref_missing",
    );
    // No half-built generation survives, and no worktree was left registered.
    assert.equal(existsSync(join(f.workspaceHome, "task-bad", "g1")), false);
    const worktrees = git(["worktree", "list", "--porcelain"], f.repoA);
    assert.equal(worktrees.includes("task-bad"), false);
    // The default branch was never substituted: the source stays on main, clean.
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], f.repoA), "main");
    assert.equal(git(["status", "--porcelain"], f.repoA), "");
  } finally {
    f.dispose();
  }
});

test("a non-repo path is refused with a clear error", () => {
  const f = fixture();
  try {
    const plain = join(f.root, "not-a-repo");
    execFileSync("mkdir", ["-p", plain]);
    assert.throws(
      () => f.manager.prepare("task-plain", [{ sourcePath: plain, baseRef: "main" }]),
      (error: Error) => error instanceof WorkspaceError && error.code === "not_a_repo",
    );
  } finally {
    f.dispose();
  }
});

test("teardown refuses a dirty worktree unless discarding is explicit", () => {
  const f = fixture();
  try {
    const workspace = f.manager.prepare("task-dirty", [{ sourcePath: f.repoA, baseRef: "main" }]);
    writeFileSync(join(workspace.repos[0]!.worktreePath, "untracked.txt"), "wip\n");
    writeFileSync(join(workspace.repos[0]!.worktreePath, "readme.txt"), "modified\n");

    const status = f.manager.status(workspace)[0]!;
    assert.equal(status.dirty, true);
    assert.deepEqual(status.untracked, ["untracked.txt"]);

    assert.throws(
      () => f.manager.teardown("task-dirty"),
      (error: Error) => error instanceof WorkspaceError && error.code === "dirty_workspace",
    );
    assert.ok(existsSync(workspace.repos[0]!.worktreePath), "dirty workspace must survive a refused teardown");

    // Explicit discard removes it.
    const removed = f.manager.teardown("task-dirty", 1, { force: true });
    assert.equal(removed.removed, true);
    assert.equal(existsSync(workspace.root), false);
  } finally {
    f.dispose();
  }
});

test("a clean workspace is removed without needing force", () => {
  const f = fixture();
  try {
    const workspace = f.manager.prepare("task-clean", [{ sourcePath: f.repoA, baseRef: "main" }]);
    assert.equal(f.manager.status(workspace)[0]!.dirty, false);
    assert.deepEqual(f.manager.teardown("task-clean"), { removed: true });
    assert.equal(existsSync(workspace.root), false);
  } finally {
    f.dispose();
  }
});

test("load() rebuilds the record from disk after a restart", () => {
  const f = fixture();
  try {
    f.manager.prepare("task-reload", [
      { sourcePath: f.repoA, baseRef: "main", name: "a" },
      { sourcePath: f.repoB, baseRef: "main", name: "b" },
    ]);
    const reloaded = new WorkspaceManager({ home: f.workspaceHome }).load("task-reload", 1);
    assert.ok(reloaded);
    assert.deepEqual(
      reloaded.repos.map((repo) => repo.name).sort(),
      ["a", "b"],
    );
    for (const repo of reloaded.repos) {
      assert.equal(repo.baseSha, git(["rev-parse", "HEAD"], repo.worktreePath));
    }
  } finally {
    f.dispose();
  }
});

test("headSha reflects the candidate commit after the executor commits", () => {
  const f = fixture();
  try {
    const workspace = f.manager.prepare("task-head", [{ sourcePath: f.repoA, baseRef: "main" }]);
    const worktree = workspace.repos[0]!.worktreePath;
    const baseSha = f.manager.headSha(worktree);

    writeFileSync(join(worktree, "change.txt"), "candidate\n");
    git(["add", "."], worktree);
    git(["commit", "-qm", "candidate"], worktree);
    const headSha = f.manager.headSha(worktree);

    assert.notEqual(headSha, baseSha);
    assert.equal(workspace.repos[0]!.baseSha, baseSha);
    assert.equal(readFileSync(join(worktree, "change.txt"), "utf8"), "candidate\n");
  } finally {
    f.dispose();
  }
});

test("preparing an already-existing generation is refused", () => {
  const f = fixture();
  try {
    f.manager.prepare("task-dup", [{ sourcePath: f.repoA, baseRef: "main" }]);
    assert.throws(
      () => f.manager.prepare("task-dup", [{ sourcePath: f.repoA, baseRef: "main" }]),
      (error: Error) => error instanceof WorkspaceError && error.code === "exists",
    );
  } finally {
    f.dispose();
  }
});
