import type { Grant } from "../store/tasks.js";

/**
 * Protocol-agnostic Handoff Capsule (docs/architecture.md "不可变目录交接",
 * docs/implementation-plan.md Step 5.1).
 *
 * The capsule is the only thing a new executor receives when it takes over:
 * it must fully describe the task contract, the remaining budget, the frozen
 * per-repo snapshot and every external side effect already made, so a
 * different provider can continue without redoing work or re-spending quota.
 */
export interface HandoffCapsule {
  taskId: string;
  fromGeneration: number;
  toGeneration: number;
  fromExecutor: string;
  toExecutor: string;
  briefVersion: number;
  goal: string;
  must: string[];
  mustNot: string[];
  /**
   * Remaining budget carried over verbatim. A handoff never resets quota; an
   * unknown total is reported as `null` rather than being guessed.
   */
  remainingAttempts: number | null;
  /** Grants still in force at handoff time. */
  grants: Grant[];
  /** Frozen per-repo snapshot. Diffs are plain strings so any provider can apply them. */
  repos: HandoffRepo[];
  /** External operations already performed (MR / CI / log citations…). */
  existingOperations: HandoffOperation[];
  /** Latest verification rejection, summarized; `null` when nothing failed yet. */
  lastVerificationFailure: HandoffVerificationFailure | null;
  /** ISO timestamp the snapshot was frozen at. */
  frozenAt: string;
}

export interface HandoffRepo {
  name: string;
  sourcePath: string;
  baseSha: string;
  /** Commit `g2` was created at. Equals `baseSha` for an uncommitted-work handoff. */
  headSha: string;
  /** `git diff --stat HEAD`: committed work since base plus staged/unstaged edits. */
  diffStat: string;
  /** `git diff HEAD`: staged + unstaged changes against HEAD as a unified patch. */
  diff: string;
  /** Untracked (and non-ignored) file contents, so they migrate too. */
  untracked: HandoffUntrackedFile[];
  /** `g2` worktree path for this repo. */
  worktreePath: string;
  branch: string;
}

export interface HandoffUntrackedFile {
  /** Repo-relative POSIX path. */
  path: string;
  /** Base64 of the raw bytes; binary-safe. */
  contentBase64: string;
  size: number;
}

export interface HandoffOperation {
  id: string;
  kind: string;
  status: string;
  /** External identifiers (PR/MR number, run id…), kept opaque. */
  externalIds?: Record<string, string | number>;
  detail?: string;
}

export interface HandoffVerificationFailure {
  result: string;
  verifierVersion: string;
  createdAt: string;
  findings: Array<{ code: string; detail: string }>;
  /** Truncated, human-readable summary of the failing steps. */
  summary: string;
}

/**
 * Committed-graph facts frozen by `WorkspaceManager.handoff()` before the
 * `g2` worktree exists. Entries are keyed by repo name so the capsule
 * construction stays pure.
 */
export interface HandoffSnapshot {
  taskId: string;
  fromGeneration: number;
  toGeneration: number;
  frozenAt: string;
  repos: HandoffRepo[];
}

/**
 * Canonical JSON for the capsule: stable key order so the serialized form can
 * be hashed and persisted, and so two equal capsules compare byte-equal.
 */
export function serializeHandoffCapsule(capsule: HandoffCapsule): string {
  return stableJson({ ...capsule });
}

/** Stable stringify with recursively sorted object keys (arrays keep order). */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortValue(entry));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries) out[key] = sortValue(entry);
    return out;
  }
  return value;
}

/** Builds the capsule from already-collected facts. Pure: no IO, no git. */
export function buildHandoffCapsule(input: HandoffCapsule): HandoffCapsule {
  return {
    taskId: input.taskId,
    fromGeneration: input.fromGeneration,
    toGeneration: input.toGeneration,
    fromExecutor: input.fromExecutor,
    toExecutor: input.toExecutor,
    briefVersion: input.briefVersion,
    goal: input.goal,
    must: [...input.must],
    mustNot: [...input.mustNot],
    remainingAttempts: input.remainingAttempts,
    grants: input.grants.map((grant) => ({ ...grant })),
    repos: input.repos.map((repo) => ({
      ...repo,
      untracked: [...repo.untracked].sort((a, b) => a.path.localeCompare(b.path)),
    })),
    existingOperations: [...input.existingOperations],
    lastVerificationFailure: input.lastVerificationFailure
      ? { ...input.lastVerificationFailure, findings: [...input.lastVerificationFailure.findings] }
      : null,
    frozenAt: input.frozenAt,
  };
}
