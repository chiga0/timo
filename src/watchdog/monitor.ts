/**
 * First-level Watchdog: pure deterministic code, zero model calls.
 *
 * It watches `running` executions only and reports four failure classes
 * (docs/architecture.md "一级：确定性 0-Token 看门狗"):
 * - `stall` — no heartbeat or output for longer than the threshold;
 * - `loop` — the same failure fingerprint repeated `>= maxSameFailure` times;
 * - `soft_deadline` — past the soft deadline with no candidate/progress marker;
 * - `scope_drift` — changed files or directories outside the agreed whitelist.
 *
 * Waiting states are deliberately exempt: `waiting_external_ci` and the other
 * legitimate waits can last 30 minutes without being a stall.
 */
export interface WatchdogThresholds {
  /** Silence beyond this is a stall. */
  stallThresholdMs: number;
  /** Soft deadline for producing a candidate or progress marker. */
  softDeadlineMs: number;
  /** Consecutive identical failure fingerprints that count as a loop. */
  maxSameFailure: number;
  /** Re-alert cooldown for the same (task, kind) window. */
  cooldownMs: number;
  /** Changed-file counts above this are drift even when paths look fine. */
  maxChangedFiles: number;
  /** Allowed path prefixes; empty means "any path is allowed". */
  allowedPathPrefixes: string[];
}

export const DEFAULT_THRESHOLDS: WatchdogThresholds = {
  stallThresholdMs: 3 * 60 * 1000,
  softDeadlineMs: 45 * 60 * 1000,
  maxSameFailure: 3,
  cooldownMs: 5 * 60 * 1000,
  maxChangedFiles: 40,
  allowedPathPrefixes: [],
};

export type WatchdogKind = "stall" | "loop" | "soft_deadline" | "scope_drift";

export interface WatchdogObservation {
  taskId: string;
  status: "accepted" | "running" | "waiting" | "verifying" | "stopping" | "stopped" | "completed" | "failed";
  waitingReason: string | null;
  /** ISO timestamp of the last observed activity (heartbeat, output, poll). */
  lastActivityAt: string;
  /** ISO timestamp when the current run started. */
  runStartedAt: string | null;
  /** Whether a candidate or explicit progress marker has been seen. */
  hasProgress: boolean;
  /** Recent failure fingerprints, most recent last. */
  failureFingerprints: string[];
  /** Files touched by the run, used for scope drift. */
  changedFiles: string[];
}

export interface WatchdogSignal {
  taskId: string;
  kind: WatchdogKind;
  detail: string;
  observedAt: string;
}

export interface WatchdogReport {
  /** Signals emitted this scan (after cooldown suppression). */
  signals: WatchdogSignal[];
  /** Per-task inspector summary regardless of alerting. */
  summaries: Array<{ taskId: string; status: "healthy" | "warning"; lastHeartbeatAt: string }>;
  /** Model calls made by the scan; always 0, surfaced so tests can assert it. */
  modelCalls: 0;
}

/** Waiting reasons that are legitimate and must never be reported as stalls. */
const EXEMPT_WAITING_REASONS = new Set(["waiting_external_ci", "needs_human_decision", "needs_cos_triage"]);

/**
 * Stateless scanner plus a small cooldown table. It never calls a model and
 * never mutates task state: it only yields signals for the caller to commit.
 */
export class WatchdogMonitor {
  private readonly lastAlertAt = new Map<string, number>();

  constructor(private readonly thresholds: Partial<WatchdogThresholds> = {}) {}

  private get config(): WatchdogThresholds {
    return { ...DEFAULT_THRESHOLDS, ...this.thresholds };
  }

  /**
   * Scans one batch of observations at `now` (injectable so tests can use a
   * virtual clock).
   */
  scan(observations: WatchdogObservation[], now: Date): WatchdogReport {
    const config = this.config;
    const signals: WatchdogSignal[] = [];
    const summaries: WatchdogReport["summaries"] = [];
    const observedAt = now.toISOString();

    for (const observation of observations) {
      const kinds: Array<{ kind: WatchdogKind; detail: string }> = [];

      // Only a live run can stall or loop; a legitimate wait is exempt.
      const running = observation.status === "running";
      const exemptWait =
        observation.status === "waiting" && observation.waitingReason !== null && EXEMPT_WAITING_REASONS.has(observation.waitingReason);

      if (running && !exemptWait) {
        const silence = now.getTime() - Date.parse(observation.lastActivityAt);
        if (silence > config.stallThresholdMs) {
          kinds.push({ kind: "stall", detail: `no activity for ${Math.round(silence / 1000)}s (threshold ${Math.round(config.stallThresholdMs / 1000)}s)` });
        }

        const repeated = trailingRepeat(observation.failureFingerprints);
        if (repeated.count >= config.maxSameFailure) {
          kinds.push({ kind: "loop", detail: `${repeated.count} consecutive failures with fingerprint ${repeated.fingerprint}` });
        }

        if (observation.runStartedAt && !observation.hasProgress) {
          const elapsed = now.getTime() - Date.parse(observation.runStartedAt);
          if (elapsed > config.softDeadlineMs) {
            kinds.push({ kind: "soft_deadline", detail: `no candidate after ${Math.round(elapsed / 60000)} min` });
          }
        }

        const drift = detectDrift(observation.changedFiles, config);
        if (drift) kinds.push({ kind: "scope_drift", detail: drift });
      }

      for (const item of kinds) {
        const key = `${observation.taskId}:${item.kind}`;
        const previous = this.lastAlertAt.get(key);
        // Cooldown: the same window must not keep re-alerting.
        if (previous !== undefined && now.getTime() - previous < config.cooldownMs) continue;
        this.lastAlertAt.set(key, now.getTime());
        signals.push({ taskId: observation.taskId, kind: item.kind, detail: item.detail, observedAt });
      }

      summaries.push({
        taskId: observation.taskId,
        status: kinds.length > 0 ? "warning" : "healthy",
        lastHeartbeatAt: observation.lastActivityAt,
      });
    }

    return { signals, summaries, modelCalls: 0 };
  }
}

/** Counts the trailing run of identical fingerprints, ignoring an empty tail. */
function trailingRepeat(fingerprints: string[]): { fingerprint: string; count: number } {
  const last = fingerprints[fingerprints.length - 1];
  if (last === undefined) return { fingerprint: "", count: 0 };
  let count = 0;
  for (let index = fingerprints.length - 1; index >= 0; index--) {
    if (fingerprints[index] !== last) break;
    count++;
  }
  return { fingerprint: last, count };
}

/** Returns a human description when the change set is out of scope, else null. */
function detectDrift(changedFiles: string[], config: WatchdogThresholds): string | null {
  if (changedFiles.length > config.maxChangedFiles) {
    return `changed ${changedFiles.length} files (limit ${config.maxChangedFiles})`;
  }
  if (config.allowedPathPrefixes.length === 0) return null;
  const outside = changedFiles.filter((file) => !config.allowedPathPrefixes.some((prefix) => file.startsWith(prefix)));
  if (outside.length === 0) return null;
  const sample = outside.slice(0, 3).join(", ");
  return `${outside.length} file(s) outside the agreed scope: ${sample}`;
}
