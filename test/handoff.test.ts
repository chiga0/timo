import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceError, WorkspaceManager } from "../src/workspace/manager.js";
import {
  buildHandoffCapsule,
  serializeHandoffCapsule,
  type HandoffCapsule,
  type HandoffSnapshot,
} from "../src/workspace/handoff.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
};

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

function makeRepo(root: string, name: string): string {
  const path = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", path], { env: GIT_ENV });
  writeFileSync(join(path, "readme.txt"), `${name}\n`);
  writeFileSync(join(path, "src.txt"), "export const value = 1;\n");
  writeFileSync(join(path, ".gitignore"), "*.log\n");
  git(["add", "."], path);
  git(["commit", "-qm", "init"], path);
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
  const root = mkdtempSync(join(tmpdir(), "timo-handoff-"));
  const workspaceHome = join(root, "workspaces");
  return {
    root,
    workspaceHome,
    repoA: makeRepo(root, "repo-a"),
    repoB: makeRepo(root, "repo-b"),
    manager: new WorkspaceManager({ home: workspaceHome }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function capsuleFrom(snapshot: HandoffSnapshot, overrides: Partial<HandoffCapsule> = {}): HandoffCapsule {
  return buildHandoffCapsule({
    taskId: snapshot.taskId,
    fromGeneration: snapshot.fromGeneration,
    toGeneration: snapshot.toGeneration,
    fromExecutor: "codex",
    toExecutor: "pi",
    briefVersion: 3,
    goal: "修复登录回跳",
    must: ["通过 npm test"],
    mustNot: ["禁止直接部署生产"],
    remainingAttempts: 2,
    grants: [{ action: "mr.create", resource: "repo-a", environment: "test", identity: null, expiresAt: null }],
    repos: snapshot.repos,
    existingOperations: [{ id: "op-1", kind: "mr.create", status: "succeeded", externalIds: { mr: 42 } }],
    lastVerificationFailure: {
      result: "rejected",
      verifierVersion: "pipe-v1",
      createdAt: "2026-11-27T00:00:00.000Z",
      findings: [{ code: "test_failed", detail: "1 failing test" }],
      summary: "command_check failed",
    },
    frozenAt: snapshot.frozenAt,
    ...overrides,
  });
}

test("uncommitted staged and unstaged changes migrate to g2 while g1 stays untouched", () => {
  const f = fixture();
  try {
    const workspace = f.manager.prepare("task-dirty", [{ sourcePath: f.repoA, baseRef: "main" }]);
    const g1 = workspace.repos[0]!.worktreePath;

    // One staged edit, one unstaged edit, one staged deletion-free modification.
    writeFileSync(join(g1, "readme.txt"), "staged change\n");
    git(["add", "readme.txt"], g1);
    writeFileSync(join(g1, "src.txt"), "export const value = 2;\n");

    const snapshot = f.manager.handoff("task-dirty", 1, 2);
    const repo = snapshot.repos[0]!;
    const g2 = repo.worktreePath;

    assert.equal(repo.baseSha, workspace.repos[0]!.baseSha);
    assert.equal(repo.headSha, git(["rev-parse", "HEAD"], g1));
    assert.equal(repo.sourcePath, f.repoA);
    assert.match(repo.diff, /\+staged change/);
    assert.match(repo.diff, /\+export const value = 2;/);
    assert.match(repo.diffStat, /2 files changed/);

    // Bytes match the source working tree…
    assert.equal(readFileSync(join(g2, "readme.txt"), "utf8"), "staged change\n");
    assert.equal(readFileSync(join(g2, "src.txt"), "utf8"), "export const value = 2;\n");
    // …and the working-tree semantics survive: still two uncommitted changes.
    assert.equal(git(["rev-parse", "HEAD"], g2), repo.baseSha);
    assert.deepEqual(git(["diff", "HEAD", "--name-only"], g2).split("\n").sort(), ["readme.txt", "src.txt"]);
    assert.deepEqual(git(["diff", "--cached", "--name-only"], g2), "readme.txt");

    // g1 keeps its own uncommitted work; nothing was committed on its behalf.
    assert.equal(readFileSync(join(g1, "src.txt"), "utf8"), "export const value = 2;\n");
    assert.notEqual(git(["diff", "HEAD", "--name-only"], g1), "");

    // g2 is registered as a fresh generation with its own manifest and branch.
    assert.notEqual(g2, g1);
    assert.match(repo.branch, /^timo\/task-dirty\/g2\/repo-a$/);
    const reloaded = f.manager.load("task-dirty", 2);
    assert.ok(reloaded);
    assert.equal(reloaded.repos[0]!.baseSha, repo.baseSha);
    assert.equal(reloaded.repos[0]!.sourcePath, f.repoA);
    assert.equal(existsSync(join(f.workspaceHome, "task-dirty", "g2", ".timo-workspace.json")), true);
    // The source clone is never dirtied by a handoff.
    assert.equal(git(["status", "--porcelain"], f.repoA), "");
  } finally {
    f.dispose();
  }
});

test("untracked files migrate byte-for-byte (including binary and nested paths) but gitignored ones do not", () => {
  const f = fixture();
  try {
    const workspace = f.manager.prepare("task-untracked", [{ sourcePath: f.repoA, baseRef: "main" }]);
    const g1 = workspace.repos[0]!.worktreePath;
    writeFileSync(join(g1, "notes.md"), "scratch notes\n");
    execFileSync("mkdir", ["-p", join(g1, "nested", "deep")]);
    writeFileSync(join(g1, "nested", "deep", "new.txt"), "nested\n");
    const binary = Buffer.from([0, 1, 2, 3, 255, 254, 10, 0]);
    writeFileSync(join(g1, "blob.bin"), binary);
    writeFileSync(join(g1, "debug.log"), "ignored\n");

    const snapshot = f.manager.handoff("task-untracked", 1, 2);
    const repo = snapshot.repos[0]!;
    assert.deepEqual(
      repo.untracked.map((file) => file.path).sort(),
      ["blob.bin", "nested/deep/new.txt", "notes.md"],
    );
    const blob = repo.untracked.find((file) => file.path === "blob.bin")!;
    assert.equal(blob.size, binary.length);
    assert.deepEqual(Buffer.from(blob.contentBase64, "base64"), binary);

    const g2 = repo.worktreePath;
    assert.equal(readFileSync(join(g2, "notes.md"), "utf8"), "scratch notes\n");
    assert.equal(readFileSync(join(g2, "nested", "deep", "new.txt"), "utf8"), "nested\n");
    assert.deepEqual(readFileSync(join(g2, "blob.bin")), binary);
    assert.equal(existsSync(join(g2, "debug.log")), false);
    assert.deepEqual(
      git(["ls-files", "--others", "--exclude-standard"], g2).split("\n").sort(),
      ["blob.bin", "nested/deep/new.txt", "notes.md"],
    );
  } finally {
    f.dispose();
  }
});

test("a zombie process still writing into g1 cannot pollute g2", async () => {
  const f = fixture();
  let zombie: ReturnType<typeof spawn> | null = null;
  try {
    const workspace = f.manager.prepare("task-zombie", [{ sourcePath: f.repoA, baseRef: "main" }]);
    const g1 = workspace.repos[0]!.worktreePath;
    writeFileSync(join(g1, "src.txt"), "export const value = 99;\n");

    const snapshot = f.manager.handoff("task-zombie", 1, 2);
    const g2 = snapshot.repos[0]!.worktreePath;
    const before = git(["status", "--porcelain"], g2);

    // A "zombie" executor keeps writing into the old generation directory.
    zombie = spawn(process.execPath, [
      "-e",
      [
        "const fs=require('fs'),p=require('path');",
        `const d=${JSON.stringify(g1)};`,
        "let n=0;",
        "const t=setInterval(()=>{",
        "  fs.writeFileSync(p.join(d,'zombie.txt'), String(n));",
        "  fs.writeFileSync(p.join(d,'src.txt'), 'export const value = '+n+';\\n');",
        "  try{fs.writeFileSync(p.join(d,'zombie-'+n+'.txt'),'x')}catch{}",
        "  n++;",
        "},10);",
        "setTimeout(()=>{clearInterval(t);process.exit(0)},400);",
      ].join("\n"),
    ]);
    await new Promise((resolve) => zombie!.once("exit", resolve));

    assert.ok(existsSync(join(g1, "zombie.txt")), "the zombie must actually have written into g1");
    assert.equal(git(["status", "--porcelain"], g2), before, "g2 status must be byte-identical after g1 writes");
    assert.equal(readFileSync(join(g2, "src.txt"), "utf8"), "export const value = 99;\n");
    assert.equal(existsSync(join(g2, "zombie.txt")), false);
    assert.equal(existsSync(join(g2, "zombie-0.txt")), false);
    assert.equal(existsSync(join(f.repoA, "zombie.txt")), false);

    // Subsequent g1 edits are equally invisible in g2.
    writeFileSync(join(g1, "src.txt"), "export const value = 1000;\n");
    assert.equal(readFileSync(join(g2, "src.txt"), "utf8"), "export const value = 99;\n");
  } finally {
    zombie?.kill("SIGKILL");
    f.dispose();
  }
});

test("handoff covers every repo of a multi-repo generation", () => {
  const f = fixture();
  try {
    const workspace = f.manager.prepare("task-multi", [
      { sourcePath: f.repoA, baseRef: "main", name: "a" },
      { sourcePath: f.repoB, baseRef: "main", name: "b" },
    ]);
    writeFileSync(join(workspace.repos[0]!.worktreePath, "readme.txt"), "a changed\n");
    writeFileSync(join(workspace.repos[1]!.worktreePath, "b-only.txt"), "b\n");

    const snapshot = f.manager.handoff("task-multi", 1, 2);
    assert.deepEqual(snapshot.repos.map((repo) => repo.name), ["a", "b"]);
    assert.match(snapshot.repos[0]!.diff, /\+a changed/);
    assert.deepEqual(snapshot.repos[1]!.untracked.map((file) => file.path), ["b-only.txt"]);
    assert.equal(readFileSync(join(snapshot.repos[0]!.worktreePath, "readme.txt"), "utf8"), "a changed\n");
    assert.equal(readFileSync(join(snapshot.repos[1]!.worktreePath, "b-only.txt"), "utf8"), "b\n");
  } finally {
    f.dispose();
  }
});

test("handoff refuses a missing source generation, a backwards target and an existing target", () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.manager.handoff("task-none", 1, 2),
      (error: Error) => error instanceof WorkspaceError && error.code === "generation_missing",
    );
    f.manager.prepare("task-guard", [{ sourcePath: f.repoA, baseRef: "main" }]);
    assert.throws(
      () => f.manager.handoff("task-guard", 1, 1),
      (error: Error) => error instanceof WorkspaceError && error.code === "invalid_generation",
    );
    f.manager.handoff("task-guard", 1, 2);
    assert.throws(
      () => f.manager.handoff("task-guard", 1, 2),
      (error: Error) => error instanceof WorkspaceError && error.code === "exists",
    );
  } finally {
    f.dispose();
  }
});

test("HandoffCapsule keeps brief, budget, operations and failure summary across serialization", () => {
  const f = fixture();
  try {
    const workspace = f.manager.prepare("task-capsule", [{ sourcePath: f.repoA, baseRef: "main" }]);
    writeFileSync(join(workspace.repos[0]!.worktreePath, "readme.txt"), "wip\n");
    const snapshot = f.manager.handoff("task-capsule", 1, 2);
    const capsule = capsuleFrom(snapshot);

    assert.equal(capsule.taskId, "task-capsule");
    assert.equal(capsule.fromGeneration, 1);
    assert.equal(capsule.toGeneration, 2);
    assert.equal(capsule.fromExecutor, "codex");
    assert.equal(capsule.toExecutor, "pi");
    assert.equal(capsule.briefVersion, 3);
    assert.equal(capsule.goal, "修复登录回跳");
    assert.deepEqual(capsule.must, ["通过 npm test"]);
    assert.deepEqual(capsule.mustNot, ["禁止直接部署生产"]);
    assert.equal(capsule.remainingAttempts, 2, "budget must carry over and never be reset");
    assert.equal(capsule.existingOperations[0]!.externalIds!.mr, 42);
    assert.equal(capsule.lastVerificationFailure!.findings[0]!.code, "test_failed");

    const serialized = serializeHandoffCapsule(capsule);
    const roundTripped = JSON.parse(serialized) as HandoffCapsule;
    assert.deepEqual(roundTripped, capsule);
    // Deterministic: rebuilding from the snapshot yields byte-identical JSON,
    // and repo untracked entries are path-sorted for reproducibility.
    assert.equal(serializeHandoffCapsule(capsuleFrom(snapshot)), serialized);
    assert.deepEqual(Object.keys(roundTripped), [...Object.keys(roundTripped)].sort());

    // Building does not alias caller arrays or nested objects.
    capsule.must.push("mutated");
    capsule.repos[0]!.untracked.push({ path: "x", contentBase64: "", size: 0 });
    assert.equal(capsuleFrom(snapshot).must.length, 1);
    assert.equal(capsuleFrom(snapshot).repos[0]!.untracked.length, 0);

    // An unknown total budget is reported as null, never guessed.
    const unknown = capsuleFrom(snapshot, { remainingAttempts: null, lastVerificationFailure: null });
    const unknownParsed = JSON.parse(serializeHandoffCapsule(unknown)) as HandoffCapsule;
    assert.equal(unknownParsed.remainingAttempts, null);
    assert.equal(unknownParsed.lastVerificationFailure, null);
  } finally {
    f.dispose();
  }
});
