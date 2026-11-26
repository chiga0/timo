import { join } from "node:path";

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

export interface T3RuntimeConfig {
  url: string;
  token: string;
  projectId: string;
  providerId: string;
  model: string;
}

export interface CreateTaskRequest {
  requestId: string;
  log: Uint8Array;
  /** Human request text sent by the caller (the assistant or the user). */
  requestText?: string;
}

export interface CreateTaskResponse {
  taskId: string;
  status: string;
}

export interface GetTaskResponse {
  taskId: string;
  status: string;
  waitingReason: string | null;
  inputDigest: string | null;
  threadId: string | null;
  runId: string | null;
  result: unknown;
  failureReason: string | null;
  verification: { result: string; verifierVersion: string; findings: unknown[]; createdAt: string } | null;
  lastObservedAt: string | null;
}

export function defaultConfig(env: NodeJS.ProcessEnv, home: string): ServiceConfig {
  return {
    home,
    databasePath: join(home, "timo.sqlite"),
    artifactDir: join(home, "artifacts"),
    socketPath: join(home, "timo.sock"),
    pollIntervalMs: positiveInt(env.TIMO_POLL_INTERVAL_MS, 500),
    waitTimeoutMs: positiveInt(env.TIMO_WAIT_TIMEOUT_MS, 5_000),
    runDeadlineMs: positiveInt(env.TIMO_RUN_DEADLINE_MS, 120_000),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
