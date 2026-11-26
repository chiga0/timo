import { readFileSync } from "node:fs";
import type { T3Client, T3ClientFactory } from "../adapters/t3.js";
import { T3Error, buildPrompt } from "../adapters/t3.js";
import { RetryTracker, failureFingerprint, DEFAULT_RETRY_POLICY, type RetryPolicy } from "../adapters/retry.js";
import type { T3RuntimeConfig } from "../config.js";
import type { TaskStore, WaitingReason } from "../store/tasks.js";
import type { ArtifactStore } from "../store/artifacts.js";
import type { TaskService } from "../service/task-service.js";
import { toIso, newId } from "../util.js";
import { SSE_CANDIDATE_SCHEMA } from "../sse/contract.js";

export interface RunnerOptions {
  store: TaskStore;
  service: TaskService;
  artifacts: ArtifactStore;
  t3: T3RuntimeConfig | null;
  clientFactory: T3ClientFactory;
  pollIntervalMs: number;
  waitTimeoutMs: number;
  runDeadlineMs: number;
  /** Bounded recovery; tests shorten the delays. */
  retryPolicy?: RetryPolicy;
  log: (line: string) => void;
}

/**
 * Background advancement. Each pass claims one pending dispatch, keeps the
 * persisted threadId/runId and re-queries after a restart instead of relying on
 * in-memory state. Network calls never run inside a database transaction.
 */
export class TaskRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private closed = false;
  private readonly active = new Set<string>();

  constructor(private readonly options: RunnerOptions) {}

  start(): void {
    const tick = () => {
      if (this.closed) return;
      void this.runOnce()
        .catch((error: unknown) => this.options.log(`runner: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          if (this.closed) return;
          this.timer = setTimeout(tick, this.options.pollIntervalMs);
          this.timer.unref?.();
        });
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Inflight passes finish on their own; a hard kill is exercised by tests.
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  /** One pass over pending tasks. Exposed for tests that drive it explicitly. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pending = this.options.store.listPendingDispatches();
      for (const item of pending) {
        if (this.active.has(item.taskId)) continue;
        const task = this.options.store.get(item.taskId);
        if (!task || task.status === "completed" || task.status === "failed") continue;
        this.active.add(item.taskId);
        try {
          await this.advance(task.taskId);
        } finally {
          this.active.delete(item.taskId);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async advance(taskId: string): Promise<void> {
    const { store, service, t3 } = this.options;
    let task = store.get(taskId);
    if (!task) return;
    const now = () => toIso(new Date());

    if (!t3) {
      this.markWaiting(taskId, "t3_unavailable", "missing T3 configuration");
      return;
    }

    const operation = store.getOperation(taskId, "dispatch");
    if (!operation) return;

    // Already dispatched: only reconcile known objects.
    if (operation.status === "done") {
      if (task.status === "running" && task.threadId && task.runId) await this.reconcile(task.threadId, task.runId);
      return;
    }

    // Backoff between dispatch attempts: a task already waiting on this
    // operation is retried only after its delay elapsed, so an unreachable T3
    // is not hammered every poll.
    if (operation.status === "in_flight" && !task.threadId) {
      const notBefore = store.getEvidence<string>(taskId, "dispatchNotBefore");
      if (notBefore && Date.parse(notBefore) > Date.now()) return;
    }

    const input = this.options.artifacts.get(task.artifactPath);
    if (input === null) {
      store.setFailure(taskId, `frozen input missing at ${task.artifactPath}`, now());
      store.setStatus(taskId, "failed", null, now());
      store.setOperationStatus(operation.operationId, "failed", { reason: "artifact_missing" }, now());
      store.enqueueNotification(taskId, "task_failed", { reason: "artifact_missing" }, now());
      return;
    }

    store.setStatus(taskId, "running", null, now());
    const retry = new RetryTracker(this.options.retryPolicy ?? DEFAULT_RETRY_POLICY);
    let client: T3Client | null = null;
    const attemptId = `${operation.operationId}:attempt:${newId()}`;

    try {
      const startedAt = Date.now();
      // A thread that could not be created is not an external effect; it only
      // exists once T3 answered with an id.
      let externalEffect = false;
      const connect = async (): Promise<T3Client> => {
        try {
          return await this.options.clientFactory(t3);
        } catch (error) {
          throw error instanceof T3Error ? error : new T3Error("transient", error instanceof Error ? error.message : String(error));
        }
      };

      const prompt = buildPrompt({ taskId, digest: task.inputDigest, logText: new TextDecoder().decode(input) });
      const modelSelection = { instanceId: t3.providerId, model: t3.model };

      // 1. v0.1.12 launches a thread together with its first prompt and the
      //    output schema, so launch IS the external effect. A persisted thread
      //    means an earlier reply was lost or the run simply needs reconciling.
      let threadId = store.get(taskId)?.threadId ?? null;
      let runId: string | null = null;
      if (!threadId) {
        store.setOperationStatus(operation.operationId, "in_flight", { phase: "launch" }, now());
        const launched = await this.withRetry(retry, client ??= await connect(), () =>
          client!.launch({
            title: `timo · ${taskId.slice(0, 8)}`,
            prompt,
            outputSchema: SSE_CANDIDATE_SCHEMA,
            modelSelection,
            clientRequestId: operation.clientRequestId,
          }),
        );
        if (!launched.ok) return this.failFromError(taskId, launched.error, attemptId, "launch", { externalEffect });
        threadId = launched.value.threadId;
        externalEffect = true;
        runId = launched.value.runId;
        store.setThread(taskId, threadId, now());
        store.recordAttempt(`${attemptId}:launch`, operation.operationId, null, { threadId, runId }, now());
      }

      // 2. Persist the run id before observing it; `untilOutput` makes the wait
      //    return only once T3 holds the structured candidate.
      let awaitedOutput: unknown;
      if (!runId) {
        const submitted = await this.withRetry(retry, client, () =>
          client!.send({ threadId: threadId!, prompt, outputSchema: SSE_CANDIDATE_SCHEMA, clientRequestId: operation.clientRequestId }),
        );
        if (!submitted.ok) return this.failFromError(taskId, submitted.error, attemptId, "submit", { externalEffect: true });
        runId = submitted.value.runId;
      }
      store.setRun(taskId, runId, now());
      const execution = store.executionFor(taskId);
      const resolveRunId = runId;
      store.upsertRunReference({
        taskId,
        executionId: execution?.executionId ?? `${taskId}:g1`,
        threadId,
        runId: resolveRunId,
        providerInstanceId: execution?.providerInstanceId ?? "unknown",
        status: "queued",
        now: now(),
      });
      store.setOperationStatus(operation.operationId, "done", { threadId, runId: resolveRunId }, now());
      store.recordAttempt(attemptId, operation.operationId, null, { runId: resolveRunId }, now());

      // 3. Bounded wait on the fixed runId. Each re-issued wait is a fresh
      //    server-side timeout, so the local deadline bounds the loop.
      const deadline = startedAt + this.options.runDeadlineMs;
      let finalStatus: string | null = null;
      while (Date.now() < deadline) {
        const waited = await this.withRetry(retry, client, () =>
          client!.wait({ threadId: threadId!, runId: resolveRunId, timeoutMs: this.options.waitTimeoutMs }),
        );
        if (!waited.ok) {
          if (waited.error.retryable) continue;
          return this.failFromError(taskId, waited.error, attemptId, "wait", { externalEffect: true });
        }
        if (waited.value.output !== undefined) awaitedOutput = waited.value.output;
        if (!waited.value.timedOut) {
          finalStatus = waited.value.status;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      if (finalStatus === null) {
        this.markWaiting(taskId, "effect_unknown", "run did not finish before the deadline; the run id stays queryable");
        return;
      }

      store.upsertRunReference({
        taskId,
        executionId: store.executionFor(taskId)?.executionId ?? `${taskId}:g1`,
        threadId,
        runId: resolveRunId,
        providerInstanceId: store.executionFor(taskId)?.providerInstanceId ?? "unknown",
        status: finalStatus,
        now: now(),
      });

      // 3. Accept only a `completed` run; anything else after a *successful*
      //    wait is a definite external outcome. A server that keeps timing out
      //    never reaches here and lands in `effect_unknown` above.
      if (finalStatus !== "completed") {
        store.setFailure(taskId, `t3 run ended as ${finalStatus}`, now());
        store.setStatus(taskId, "failed", null, now());
        store.enqueueNotification(taskId, "task_failed", { reason: `run_${finalStatus}` }, now());
        return;
      }

      store.setStatus(taskId, "verifying", null, now());
      if (!client) return this.failFromError(taskId, new T3Error("transient", "no client"), attemptId, "read", { externalEffect: true });
      const reading = await this.readCandidate(store, client, threadId, resolveRunId, taskId, awaitedOutput);
      if ("reason" in reading) {
        // No structured candidate: T3 completed, Timo does not accept that alone.
        store.setStatus(taskId, "failed", null, now());
        store.setFailure(taskId, reading.reason, now());
        store.enqueueNotification(taskId, "task_failed", { reason: reading.reason }, now());
        return;
      }
      const verdict = service.acceptCandidate(taskId, reading.candidate, runId);
      this.options.log(`task ${taskId}: verifier ${verdict.status}`);
    } catch (error) {
      const kind = error instanceof T3Error ? error : null;
      if (kind?.kind === "auth" || kind?.kind === "transient" || kind?.kind === "timeout") {
        this.markWaiting(taskId, kind.kind === "auth" ? "t3_auth" : "t3_unavailable", kind.message);
      } else {
        store.setFailure(taskId, error instanceof Error ? error.message : String(error), now());
        store.setStatus(taskId, "failed", null, now());
      }
    } finally {
      await client?.close().catch(() => undefined);
    }
    void task;
  }

  private async reconcile(threadId: string, runId: string): Promise<void> {
    if (!this.options.t3) return;
    let client: T3Client | null = null;
    try {
      client = await this.options.clientFactory(this.options.t3);
      const reading = await client.read({ threadId, runId });
      this.options.log(`reconcile ${threadId}/${runId}: run=${reading.runStatus} thread=${reading.threadStatus}`);
    } catch (error) {
      this.options.log(`reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  /**
   * Resolves the structured candidate. `t3_thread_wait` with `untilOutput`
   * returns what the run submitted against the `outputSchema`; if T3 finished
   * without one, a JSON object in the assistant text is parsed as a fallback and
   * still verified deterministically.
   */
  private async readCandidate(
    store: TaskStore,
    client: T3Client,
    threadId: string,
    runId: string,
    taskId: string,
    awaitedOutput: unknown,
  ): Promise<{ candidate: unknown } | { candidate: undefined; reason: string }> {
    if (awaitedOutput !== undefined && awaitedOutput !== null) return { candidate: awaitedOutput };
    const retry = new RetryTracker();
    const outcome = await this.withRetry(retry, client, () => client!.read({ threadId, runId }));
    if (!outcome.ok) return { candidate: undefined, reason: `read failed: ${outcome.error.message}` };
    const reading = outcome.value;
    store.setEvidence(taskId, "assistantText", reading.assistantText ?? "", toIso(new Date()));
    const parsed = extractJsonObject(reading.assistantText);
    if (parsed === undefined) return { candidate: undefined, reason: "t3 run completed without a structured JSON candidate" };
    return { candidate: parsed };
  }

  private async withRetry<T>(retry: RetryTracker, client: T3Client | null, call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: T3Error }> {
    for (;;) {
      if (!client) return { ok: false, error: new T3Error("transient", "no client") };
      try {
        const value = await call();
        retry.reset();
        return { ok: true, value };
      } catch (error) {
        const t3Error = error instanceof T3Error ? error : new T3Error("protocol", String(error));
        if (!t3Error.retryable) return { ok: false, error: t3Error };
        const decision = retry.record(failureFingerprint(t3Error));
        if (!decision.retry) return { ok: false, error: t3Error };
        await new Promise((resolve) => setTimeout(resolve, retry.delayMs()));
      }
    }
  }

  /**
   * `externalEffect` decides between two very different outcomes: a request
   * that never reached T3 waits as `t3_unavailable`; one that may have reached
   * it waits as `effect_unknown` and is re-queried, never blindly resent.
   */
  private failFromError(taskId: string, error: T3Error, attemptId: string, phase: string, options: { externalEffect: boolean }): void {
    const { store } = this.options;
    const now = toIso(new Date());
    const operation = store.getOperation(taskId, "dispatch");
    if (operation) store.recordAttempt(attemptId, operation.operationId, error.kind, { phase, message: error.message }, now);
    if (error.kind === "auth") {
      this.markWaiting(taskId, "t3_auth", error.message);
      return;
    }
    if (error.kind === "timeout" || error.kind === "transient") {
      this.markWaiting(taskId, options.externalEffect ? "effect_unknown" : "t3_unavailable", `${phase}: ${error.message}`);
      return;
    }
    store.setFailure(taskId, `${phase}: ${error.message}`, now);
    store.setStatus(taskId, "failed", null, now);
    if (operation) store.setOperationStatus(operation.operationId, "failed", { phase, message: error.message }, now);
    store.enqueueNotification(taskId, "task_failed", { phase, reason: error.kind }, now);
  }

  private markWaiting(taskId: string, reason: WaitingReason, detail: string): void {
    const { store } = this.options;
    const now = toIso(new Date());
    const task = store.get(taskId);
    if (!task || task.status === "completed" || task.status === "failed") return;
    store.setStatus(taskId, "waiting", reason, now);
    store.enqueueNotification(taskId, `waiting_${reason}`, { waitingReason: reason, detail }, now);
    if (reason === "t3_unavailable" || reason === "effect_unknown") {
      // Retry after a bounded backoff instead of on every poll.
      const delay = this.backoffFor(taskId);
      store.setEvidence(taskId, "dispatchNotBefore", toIso(new Date(Date.now() + delay)), now);
    }
    this.options.log(`task ${reason}: ${detail}`);
  }

  private backoffFor(taskId: string): number {
    const { store } = this.options;
    const previous = store.getEvidence<number>(taskId, "dispatchFailures") ?? 0;
    const count = previous + 1;
    store.setEvidence(taskId, "dispatchFailures", count, toIso(new Date()));
    const policy = this.options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    return Math.min(policy.maxDelayMs, this.options.pollIntervalMs * 4 * 2 ** Math.min(count - 1, 6));
  }
}

function readArtifact(path: string): Uint8Array | null {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return null;
  }
}

export function extractJsonObject(text: string | undefined): unknown {
  if (!text) return undefined;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
  for (const match of text.matchAll(fenced)) {
    const parsed = tryParse(match[1]);
    if (parsed !== undefined) return parsed;
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) return undefined;
  return tryParse(text.slice(first, last + 1));
}

function tryParse(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}
