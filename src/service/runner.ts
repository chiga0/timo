import type { T3Client, T3ClientFactory } from "../adapters/t3.js";
import { T3Error, buildPrompt } from "../adapters/t3.js";
import { RetryTracker, failureFingerprint, DEFAULT_RETRY_POLICY, type RetryPolicy } from "../adapters/retry.js";
import type { T3RuntimeConfig } from "../config.js";
import type { TaskStore, WaitingReason } from "../store/tasks.js";
import type { ArtifactStore } from "../store/artifacts.js";
import type { TaskService } from "../service/task-service.js";
import type { TransitionWriter } from "../events/writer.js";
import { JOB_DISPATCH } from "../events/writer.js";
import { toIso, newId } from "../util.js";
import { SSE_CANDIDATE_SCHEMA } from "../sse/contract.js";

export interface RunnerOptions {
  store: TaskStore;
  service: TaskService;
  artifacts: ArtifactStore;
  /** Commits every transition atomically with its event and follow-up jobs. */
  writer: TransitionWriter;
  t3: T3RuntimeConfig | null;
  clientFactory: T3ClientFactory;
  pollIntervalMs: number;
  waitTimeoutMs: number;
  runDeadlineMs: number;
  /** Tasks advanced in parallel per pass. Different task ids never block each other. */
  concurrency?: number;
  /** Bounded recovery; tests shorten the delays. */
  retryPolicy?: RetryPolicy;
  log: (line: string) => void;
}

/**
 * Background advancement. Each pass claims pending dispatches and in-flight
 * tasks, keeps the persisted threadId/runId and re-queries after a restart
 * instead of relying on in-memory state. Network calls never run inside a
 * database transaction, and different task ids advance concurrently so one slow
 * run cannot head-of-line block the rest.
 */
export class TaskRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private closed = false;
  private readonly active = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  /** Identifies this process's outbox leases; a restarted process steals expired ones. */
  private readonly owner = `runner-${process.pid}-${newId().slice(0, 8)}`;
  private readonly leaseMs: number;
  private claimedJobs: Array<{ jobId: string; taskId: string }> = [];

  constructor(private readonly options: RunnerOptions) {
    this.leaseMs = Math.max(options.pollIntervalMs * 10, 30_000);
  }

  private get concurrency(): number {
    return Math.max(1, this.options.concurrency ?? 4);
  }

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
    while (this.running || this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * One pass. Dispatch work and in-flight reconciliation are separate queues: a
   * task whose external run is still going is reconciled in later passes without
   * consuming a dispatch slot. Dispatch is driven by durable outbox leases, so a
   * restart resumes from the database rather than from memory.
   */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const work = new Map<string, "dispatch" | "reconcile">();
      this.claimedJobs = this.options.writer.outbox
        .claim({
          owner: this.owner,
          now: toIso(new Date()),
          limit: this.concurrency * 4,
          leaseMs: this.leaseMs,
          kinds: [JOB_DISPATCH],
        })
        .map((job) => ({ jobId: job.jobId, taskId: job.taskId }));
      for (const job of this.claimedJobs) {
        const task = this.options.store.get(job.taskId);
        if (!task || task.status === "completed" || task.status === "failed") continue;
        if (!work.has(job.taskId)) work.set(job.taskId, "dispatch");
      }
      for (const item of this.options.store.listPendingDispatches()) {
        const task = this.options.store.get(item.taskId);
        if (!task || task.status === "completed" || task.status === "failed") continue;
        if (!work.has(item.taskId)) work.set(item.taskId, "dispatch");
      }
      for (const item of this.options.store.listInflightTasks()) {
        if (!work.has(item.taskId)) work.set(item.taskId, "reconcile");
      }

      const queue = [...work.entries()].filter(([taskId]) => !this.active.has(taskId));
      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const next = queue[cursor++];
          if (!next) return;
          const [taskId, mode] = next;
          if (this.closed) return;
          this.active.add(taskId);
          const promise = (mode === "dispatch" ? this.advance(taskId) : this.reconcileTask(taskId))
            .catch((error: unknown) => {
              this.options.log(`runner ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
            })
            .finally(() => {
              this.finishClaimedJobs(taskId);
              this.active.delete(taskId);
              this.inflight.delete(promise);
            });
          this.inflight.add(promise);
          await promise;
        }
      };
      const workers = Array.from({ length: Math.min(this.concurrency, Math.max(1, queue.length)) }, () => worker());
      await Promise.all(workers);
    } finally {
      this.running = false;
    }
  }

  /**
   * Re-queries an in-flight run after a restart or a missed notification. A
   * completed remote run is carried through the same `readCandidate ->
   * acceptCandidate` closure as a live one; nothing is trusted from memory.
   */
  private async reconcileTask(taskId: string): Promise<void> {
    const { store, t3 } = this.options;
    const task = store.get(taskId);
    if (!task || !task.threadId || !task.runId) return;
    if (!t3) return;
    const now = () => toIso(new Date());
    const retry = new RetryTracker(this.options.retryPolicy ?? DEFAULT_RETRY_POLICY);
    let client: T3Client | null = null;
    try {
      client = await this.connect(t3);
      const outcome = await this.withRetry(retry, client, () =>
        client!.wait({ threadId: task.threadId!, runId: task.runId!, timeoutMs: this.options.waitTimeoutMs }),
      );
      if (!outcome.ok) {
        if (outcome.error.kind === "auth") this.markWaiting(taskId, "t3_auth", outcome.error.message);
        return;
      }
      if (outcome.value.timedOut) return;
      if (outcome.value.status !== "completed") {
        await this.finishRemoteRun(taskId, task.threadId, task.runId, outcome.value.status);
        return;
      }
      await this.finishCompletedRun(taskId, task.threadId, task.runId, outcome.value.output, retry);
    } catch (error) {
      const t3Error = error instanceof T3Error ? error : null;
      if (t3Error?.kind === "auth") this.markWaiting(taskId, "t3_auth", t3Error.message);
      else this.options.log(`reconcile ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  /** Records a definite non-completed remote outcome and fails the task. */
  private async finishRemoteRun(taskId: string, threadId: string, runId: string, status: string): Promise<void> {
    const { store } = this.options;
    const now = toIso(new Date());
    store.upsertRunReference({
      taskId,
      executionId: store.executionFor(taskId)?.executionId ?? `${taskId}:g1`,
      threadId,
      runId,
      providerInstanceId: store.executionFor(taskId)?.providerInstanceId ?? "unknown",
      status,
      now,
    });
    store.setFailure(taskId, `t3 run ended as ${status}`, now);
    store.setStatus(taskId, "failed", null, now);
    store.enqueueNotification(taskId, "task_failed", { reason: `run_${status}` }, now);
  }

  /**
   * Completes the pipeline for a `completed` run: persist the observation, move
   * to verifying, read the candidate and let the verifier decide. Shared by the
   * live dispatch path and reconciliation so the two cannot diverge.
   */
  private async finishCompletedRun(taskId: string, threadId: string, runId: string, output: unknown, retry: RetryTracker): Promise<void> {
    const { store, service } = this.options;
    const now = toIso(new Date());
    const fail = (reason: string) => {
      store.setStatus(taskId, "failed", null, now);
      store.setFailure(taskId, reason, now);
      store.enqueueNotification(taskId, "task_failed", { reason }, now);
    };
    store.upsertRunReference({
      taskId,
      executionId: store.executionFor(taskId)?.executionId ?? `${taskId}:g1`,
      threadId,
      runId,
      providerInstanceId: store.executionFor(taskId)?.providerInstanceId ?? "unknown",
      status: "completed",
      now,
    });
    const current = store.get(taskId);
    if (!current || current.status === "completed" || current.status === "failed") return;
    store.setStatus(taskId, "verifying", null, now);

    let client: T3Client | null = null;
    try {
      client = await this.connect(this.options.t3!);
      const reading = await this.readCandidate(store, client, threadId, runId, taskId, output);
      if ("reason" in reading) return fail(reading.reason);
      const verdict = service.acceptCandidate(taskId, reading.candidate, runId);
      this.options.log(`task ${taskId}: verifier ${verdict.status}`);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  private async connect(t3: T3RuntimeConfig): Promise<T3Client> {
    try {
      return await this.options.clientFactory(t3);
    } catch (error) {
      throw error instanceof T3Error ? error : new T3Error("transient", error instanceof Error ? error.message : String(error));
    }
  }

  private async advance(taskId: string): Promise<void> {
    const { store, t3 } = this.options;
    const task = store.get(taskId);
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
      if (task.threadId && task.runId) await this.reconcileTask(taskId);
      return;
    }

    // Backoff between dispatch attempts: a task already waiting on this
    // operation is retried only after its delay elapsed, so an unreachable T3
    // is not hammered every poll.
    const notBefore = store.getEvidence<string>(taskId, "dispatchNotBefore");
    if (notBefore && Date.parse(notBefore) > Date.now()) return;

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
      // The execution row started as `pending`; bind it to the identity actually used.
      store.bindExecution(taskId, modelSelection.instanceId, modelSelection.model, now());
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

      // 3. Accept only a `completed` run; anything else after a *successful*
      //    wait is a definite external outcome. A server that keeps timing out
      //    never reaches here and lands in `effect_unknown` above.
      if (finalStatus !== "completed") {
        await this.finishRemoteRun(taskId, threadId, resolveRunId, finalStatus);
        return;
      }

      await this.finishCompletedRun(taskId, threadId, resolveRunId, awaitedOutput, retry);
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

  /**
   * Marks this pass's claimed jobs done once the task has been advanced. Liveness
   * for a still-running task comes from `listInflightTasks`, not from repeatedly
   * re-claiming the dispatch job.
   */
  private finishClaimedJobs(taskId: string): void {
    const now = toIso(new Date());
    for (const job of this.claimedJobs) {
      if (job.taskId !== taskId) continue;
      this.options.writer.outbox.complete(job.jobId, now);
    }
    this.claimedJobs = this.claimedJobs.filter((job) => job.taskId !== taskId);
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
