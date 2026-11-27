import { join } from "node:path";
import type { T3Config } from "./adapters/t3.js";
import type { RepoRequest } from "./workspace/manager.js";
import type { VerificationPlan } from "./verify/pipeline.js";

export interface ServiceConfig {
  home: string;
  databasePath: string;
  artifactDir: string;
  socketPath: string;
  /** Poll interval for the dispatch loop, in ms. */
  pollIntervalMs: number;
  /** Bound on one t3_thread_wait call; the loop re-issues until the deadline. */
  waitTimeoutMs: number;
  /** Total wall clock a run may take before the service reports waiting. */
  runDeadlineMs: number;
}

/** Re-exported so the service config and the adapter share one config type. */
export type T3RuntimeConfig = T3Config;

export type TaskKind = "sse_log" | "repo_delivery" | "review" | "assistant_chat";

export interface CreateTaskRequest {
  requestId: string;
  /** Legacy/zero-repo SSE log input (required when kind is omitted or 'sse_log'). */
  log?: Uint8Array;
  /** Task kind: defaults to 'sse_log' when `log` is provided, or 'repo_delivery' when `repos` is provided. */
  kind?: TaskKind;
  /** Human request text sent by the caller (the assistant or the user). */
  requestText?: string;
  /** Explicit executor id (e.g. 'pi', 't3'). Missing executor is rejected, never silently substituted. */
  executorId?: string;
  /** Model override forwarded to the executor. */
  model?: string;
  /** Repositories for `repo_delivery` tasks. */
  repos?: RepoRequest[];
  /** Declarative verification pipeline; defaults to `log_citation` for sse_log. */
  verificationPlan?: VerificationPlan;
  /** Bounded in-budget auto-repair rounds on verification failure (default 2). */
  maxRepairRounds?: number;
  /** Additional task-specific initial grants. */
  grants?: Array<{ action: string; resource: string; environment?: string | null; identity?: string | null; expiresAt?: string | null }>;
}

export interface CreateTaskResponse {
  taskId: string;
  status: string;
}

export interface RepoDeliveryState {
  name: string;
  sourcePath: string;
  baseRef: string;
  baseSha?: string | null;
  headSha?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  mrId?: string | null;
  mrUrl?: string | null;
  mrHeadSha?: string | null;
  ciStatus?: "pending" | "passed" | "failed" | "stale" | "unknown" | null;
  ciHeadSha?: string | null;
  ciChecks?: Array<{ name: string; status: string }>;
}

export interface GetTaskResponse {
  taskId: string;
  /** Short human-readable title derived from the task's requestText / brief goal or user override. */
  title?: string;
  /** ISO timestamp when the task was archived, or null if active. */
  archivedAt?: string | null;
  /** Full latest request text submitted for this task. */
  requestText?: string;
  kind?: TaskKind;
  executorId?: string | null;
  status: string;
  waitingReason: string | null;
  inputDigest: string | null;
  threadId: string | null;
  runId: string | null;
  result: unknown;
  failureReason: string | null;
  verification: {
    result: string;
    verifierVersion: string;
    findings: unknown[];
    createdAt: string;
    stale?: boolean;
    candidateDigest?: string | null;
  } | null;
  repos?: RepoDeliveryState[];
  verificationPlan?: VerificationPlan | null;
  operations?: Array<{
    operationId: string;
    kind: string;
    status: string;
    operationKey: string | null;
    clientRequestId: string;
    receipt: unknown;
    reconciledAt: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
  lastObservedAt: string | null;
  /** Current brief revision; callers must echo it back when amending. */
  briefVersion: number;
}

export function defaultConfig(env: NodeJS.ProcessEnv, home: string): ServiceConfig {
  return {
    home,
    databasePath: join(home, "timo.sqlite"),
    artifactDir: join(home, "artifacts"),
    socketPath: join(home, "timo.sock"),
    pollIntervalMs: positiveInt(env.TIMO_POLL_INTERVAL_MS, 500),
    waitTimeoutMs: positiveInt(env.TIMO_WAIT_TIMEOUT_MS, 5_000),
    // 0 = no artificial wall-clock kill; live agent runs are supervised by Watchdog + user Stop.
    runDeadlineMs: positiveInt(env.TIMO_RUN_DEADLINE_MS, 0),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
