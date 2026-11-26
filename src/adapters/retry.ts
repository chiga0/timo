import type { T3Error } from "../adapters/t3.js";

export interface RetryPolicy {
  maxSameFailure: number;
  firstDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxSameFailure: 3, firstDelayMs: 1_000, maxDelayMs: 30_000 };

interface FailureRecord {
  fingerprint: string;
  count: number;
}

/**
 * Bounded recovery for one dispatch or read step. Retries stop when the same
 * failure repeats more than `maxSameFailure` times or a new error kind appears,
 * so a task cannot extend itself by restating the same failure.
 */
export class RetryTracker {
  private failure: FailureRecord | null = null;

  constructor(private readonly policy: RetryPolicy = DEFAULT_RETRY_POLICY) {}

  record(fingerprint: string): { retry: boolean; count: number } {
    if (this.failure && this.failure.fingerprint === fingerprint) this.failure.count++;
    else this.failure = { fingerprint, count: 1 };
    return { retry: this.failure.count <= this.policy.maxSameFailure, count: this.failure.count };
  }

  reset(): void {
    this.failure = null;
  }

  get failedSameTimes(): number {
    return this.failure?.count ?? 0;
  }

  delayMs(): number {
    const count = this.failure?.count ?? 1;
    return Math.min(this.policy.maxDelayMs, this.policy.firstDelayMs * 2 ** (count - 1));
  }
}

export function failureFingerprint(error: T3Error): string {
  return `${error.kind}:${error.message}`;
}
