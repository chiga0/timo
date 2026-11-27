/**
 * One executor abstraction for every runtime Timo can drive (T3 over MCP, or a
 * native CLI spawned as a child process). The interface exists so the scheduler
 * never knows which runtime is behind a task, and so live run output has a
 * single normalised shape.
 *
 * Nothing here starts an agent loop of its own: `spawn` launches a mature
 * runtime and `streamEvents` translates its output.
 */

export type RunStreamEventType = "text_delta" | "thinking" | "tool_call" | "tool_result" | "shell" | "patch" | "status" | "error";

/**
 * Normalised live-run event. These go to `<TIMO_HOME>/runs/<taskId>/<runId>.ndjson`
 * and to the live SSE stream only — never into `task_events` or the inbox.
 */
export interface RunStreamEvent {
  /** Monotonic within one run, starting at 1. */
  seq: number;
  runId: string;
  taskId: string;
  type: RunStreamEventType;
  /** Epoch milliseconds when the adapter observed the event. */
  at: number;
  /** Human-readable one-liner, already truncated to a sane length. */
  summary: string;
  /** Structured detail; shape depends on `type`. */
  data?: unknown;
}

export interface ExecutorDescriptor {
  id: string;
  kind: "mcp" | "cli";
  available: boolean;
  /** Why it is unavailable, for the auth/health panel. */
  reason?: string;
  /** Free-form capability flags, e.g. `{ steer: true, resume: true }`. */
  capabilities: Record<string, boolean>;
}

export interface SpawnRequest {
  taskId: string;
  runId: string;
  /** Absolute worktree directory the executor must run inside. */
  cwd: string;
  /** The full prompt to hand to the runtime. */
  prompt: string;
  /** Optional model override understood by the runtime. */
  model?: string;
  /** Hard wall-clock ceiling for the process, in ms. */
  timeoutMs?: number;
  /** Scoped Capability MCP Gateway URL for this execution generation (Step 4.1). */
  mcpGatewayUrl?: string;
  /** Non-sensitive environment variables injected explicitly for the worker. */
  env?: Record<string, string>;
}

/**
 * Env vars carrying real platform/business credentials that must never enter a
 * worker child process (docs/architecture.md "凭据物理隔离"). Only the local
 * Capability MCP Gateway reads these.
 */
const SECRET_ENV_PATTERNS: ReadonlyArray<RegExp> = [
  /^GH_TOKEN$/i,
  /^GITHUB_TOKEN$/i,
  /^GITLAB_TOKEN$/i,
  /^A1_TOKEN$/i,
  /^AONE_TOKEN$/i,
  /^TIMO_SESSION_TOKEN$/i,
  /^TIMO_PLATFORM_/i,
  /^TIMO_SECRET_/i,
  /^PROD_/i,
  /^DEPLOY_/i,
  /_SECRET_KEY$/i,
  /_ACCESS_TOKEN$/i,
];

/** Builds a clean worker environment with sensitive business tokens removed. */
export function buildIsolatedWorkerEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  extraEnv?: Record<string, string>,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;
    clean[key] = value;
  }
  clean.GIT_TERMINAL_PROMPT = "0";
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;
      clean[key] = value;
    }
  }
  return clean;
}

export interface SpawnResult {
  runId: string;
  /** Runtime-native session/thread id when the executor exposes one. */
  externalId: string | null;
  status: "succeeded" | "failed" | "interrupted" | "timed_out";
  exitCode: number | null;
  /** Final assistant text, if any. */
  output: string;
}

export interface ExecutionAdapter {
  readonly id: string;

  /** Preflight: is this runtime usable right now? Never throws. */
  probe(): Promise<ExecutorDescriptor>;

  /** Starts a run and resolves when the runtime process/session settles. */
  spawn(request: SpawnRequest, onEvent: (event: RunStreamEvent) => void): Promise<SpawnResult>;

  /** Re-attaches to a run that already exists (after a restart). */
  resume(runId: string, onEvent: (event: RunStreamEvent) => void): Promise<SpawnResult>;

  /** Sends a corrective instruction into a live run. */
  steer(runId: string, message: string): Promise<{ accepted: boolean; reason?: string }>;

  /** Interrupts a live run. Idempotent: interrupting a finished run is a no-op. */
  interrupt(runId: string): Promise<{ interrupted: boolean; reason?: string }>;
}

/** Raised when a caller asks for an executor that does not exist or is unusable. */
export class ExecutorUnavailableError extends Error {
  override readonly name = "ExecutorUnavailableError";
  constructor(
    readonly executorId: string,
    reason: string,
  ) {
    super(`executor ${executorId} is unavailable: ${reason}`);
  }
}

/**
 * Registry with explicit selection. A request for an unknown or unusable
 * executor fails loudly; there is no silent fallback to another runtime.
 */
export class ExecutorRegistry {
  private readonly adapters = new Map<string, ExecutionAdapter>();
  private readonly descriptors = new Map<string, ExecutorDescriptor>();

  register(adapter: ExecutionAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /** Runs preflight on every adapter and caches the result for the health panel. */
  async probeAll(): Promise<ExecutorDescriptor[]> {
    const results: ExecutorDescriptor[] = [];
    for (const adapter of this.adapters.values()) {
      try {
        const descriptor = await adapter.probe();
        this.descriptors.set(descriptor.id, descriptor);
        results.push(descriptor);
      } catch (error) {
        const descriptor: ExecutorDescriptor = {
          id: adapter.id,
          kind: "cli",
          available: false,
          reason: error instanceof Error ? error.message : String(error),
          capabilities: {},
        };
        this.descriptors.set(descriptor.id, descriptor);
        results.push(descriptor);
      }
    }
    return results;
  }

  /** Returns the adapter, or throws rather than picking a different executor. */
  require(executorId: string): ExecutionAdapter {
    const adapter = this.adapters.get(executorId);
    if (!adapter) throw new ExecutorUnavailableError(executorId, "not registered");
    const descriptor = this.descriptors.get(executorId);
    if (descriptor && !descriptor.available) throw new ExecutorUnavailableError(executorId, descriptor.reason ?? "probe failed");
    return adapter;
  }

  snapshot(): ExecutorDescriptor[] {
    return [...this.descriptors.values()];
  }

  has(executorId: string): boolean {
    return this.adapters.has(executorId);
  }
}
