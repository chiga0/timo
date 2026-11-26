import type { T3Client, T3ClientFactory } from "../adapters/t3.js";
import { T3Error, buildPrompt } from "../adapters/t3.js";
import { RetryTracker, failureFingerprint, DEFAULT_RETRY_POLICY, type RetryPolicy } from "../adapters/retry.js";
import type { T3RuntimeConfig } from "../config.js";
import type { TaskStore, TaskStatus, WaitingReason } from "../store/tasks.js";
import { isTerminal } from "../store/tasks.js";
import type { ArtifactStore } from "../store/artifacts.js";
import type { TaskService } from "../service/task-service.js";
import type { TransitionWriter } from "../events/writer.js";
import { JOB_DISPATCH, JOB_STOP } from "../events/writer.js";
import type { TypedEventBus } from "../events/bus.js";
import { toIso, newId } from "../util.js";
import { SSE_CANDIDATE_SCHEMA } from "../sse/contract.js";
import { WatchdogMonitor, type WatchdogThresholds } from "../watchdog/monitor.js";
import type { RunStreamStore } from "../workspace/run-stream.js";
import type { ExecutorRegistry } from "../adapters/execution.js";

const NON_RUNNABLE_WAIT_REASONS: ReadonlySet<string> = new Set([
  "needs_human_decision",
  "needs_cos_triage",
  "input_incomplete",
  "waiting_external_ci",
  "budget_exhausted",
]);

export interface RunnerOptions {
  store: TaskStore;
  service: TaskService;
  artifacts: ArtifactStore;
  /** Commits every transition atomically with its event and follow-up jobs. */
  writer: TransitionWriter;
  /** Optional event bus for immediate online wake-up on `task_created` / `task_stopping`. */
  bus?: TypedEventBus;
  t3: T3RuntimeConfig | null;
  clientFactory: T3ClientFactory;
  pollIntervalMs: number;
  waitTimeoutMs: number;
  runDeadlineMs: number;
  /** Tasks advanced in parallel per pass. Different task ids never block each other. */
  concurrency?: number;
  /** Bounded recovery; tests shorten the delays. */
  retryPolicy?: RetryPolicy;
  /** Watchdog thresholds; `null` disables the first-level scan. */
  watchdog?: Partial<WatchdogThresholds> | null;
  /** Live run stream sink + executor registry (Step 3.2). Absent disables both. */
  runStreams?: RunStreamStore;
  executors?: ExecutorRegistry;
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
  private wakePending = false;
  private readonly unsubscribes: Array<() => void> = [];
  private readonly active = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  /** Identifies this process's outbox leases; a restarted process steals expired ones. */
  private readonly owner = `runner-${process.pid}-${newId().slice(0, 8)}`;
  private readonly leaseMs: number;
  private claimedJobs: Array<{ jobId: string; taskId: string; kind: string }> = [];
  /** First-level watchdog: deterministic, injectable clock, zero model calls. */
  private readonly watchdog: WatchdogMonitor | null;

  constructor(private readonly options: RunnerOptions) {
    this.leaseMs = Math.max(options.pollIntervalMs * 10, 30_000);
    this.watchdog = options.watchdog === null ? null : new WatchdogMonitor(options.watchdog ?? {});
  }

  private get concurrency(): number {
    return Math.max(1, this.options.concurrency ?? 4);
  }

  start(): void {
    const schedule = (delayMs: number) => {
      if (this.closed) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(tick, delayMs);
      this.timer.unref?.();
    };
    const tick = () => {
      if (this.closed) return;
      this.timer = null;
      this.wakePending = false;
      void this.runOnce()
        .catch((error: unknown) => this.options.log(`runner: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          if (this.closed) return;
          schedule(this.wakePending ? 0 : this.options.pollIntervalMs);
        });
    };
    if (this.options.bus) {
      const wake = () => {
        if (this.closed) return;
        if (this.running) {
          this.wakePending = true;
          return;
        }
        schedule(0);
      };
      this.unsubscribes.push(this.options.bus.on("task_created", wake));
      this.unsubscribes.push(this.options.bus.on("task_stopping", wake));
      this.unsubscribes.push(
        this.options.bus.on("run_observed", (event) => {
          const auth = (event.payload as { authorization?: { approved?: boolean } } | null)?.authorization;
          if (auth?.approved === true) wake();
        }),
      );
    }
    schedule(0);
  }

  async stop(): Promise<void> {
    this.closed = true;
    for (const unsub of this.unsubscribes.splice(0)) unsub();
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
      // First-level watchdog: deterministic, zero model calls, before any work.
      this.scanWatchdog();
      const work = new Map<string, "dispatch" | "reconcile" | "stop">();
      const claimed = this.options.writer.outbox.claim({
        owner: this.owner,
        now: toIso(new Date()),
        limit: this.concurrency * 4,
        leaseMs: this.leaseMs,
        kinds: [JOB_DISPATCH, JOB_STOP],
      });
      this.claimedJobs = claimed.map((job) => ({ jobId: job.jobId, taskId: job.taskId, kind: job.kind }));
      for (const job of claimed) {
        const task = this.options.store.get(job.taskId);
        if (!task) continue;
        if (task.status === "stopping") work.set(job.taskId, "stop");
        else if (this.isTaskRunnable(task)) {
          if (!work.has(job.taskId) || work.get(job.taskId) === "reconcile") work.set(job.taskId, "dispatch");
        }
      }
      // A stop intent that outlived its job (restart, lease expiry) is still
      // honoured: the task row is authoritative, the job is only a wake-up.
      for (const item of this.options.store.listStoppingTasks()) {
        if (!work.has(item.taskId)) work.set(item.taskId, "stop");
      }
      for (const item of this.options.store.listPendingDispatches()) {
        const task = this.options.store.get(item.taskId);
        if (!task || !this.isTaskRunnable(task)) continue;
        if (!work.has(item.taskId)) work.set(item.taskId, "dispatch");
      }
      for (const item of this.options.store.listInflightTasks()) {
        if (!this.isTaskRunnable(item)) continue;
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
          let threwError: string | null = null;
          const promise = (
            mode === "dispatch" ? this.advance(taskId) : mode === "stop" ? this.stopTask(taskId) : this.reconcileTask(taskId)
          )
            .catch((error: unknown) => {
              threwError = error instanceof Error ? error.message : String(error);
              this.options.log(`runner ${taskId}: ${threwError}`);
            })
            .finally(() => {
              this.finishClaimedJobs(taskId, threwError);
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

  /** Only these states may be automatically dispatched or reconciled without human input. */
  private isRunnable(status: TaskStatus): boolean {
    return status === "accepted" || status === "running" || status === "waiting";
  }

  private isTaskRunnable(task: { status: TaskStatus; waitingReason: WaitingReason | null }): boolean {
    if (task.status === "accepted" || task.status === "running") return true;
    if (task.status !== "waiting") return false;
    // Human-gated, incomplete, budget-exhausted, and external-CI waits must never be auto-dispatched.
    if (task.waitingReason === null) return true;
    return !NON_RUNNABLE_WAIT_REASONS.has(task.waitingReason);
  }

  /**
   * First-level watchdog scan: deterministic, zero model calls. It reads the
   * task rows, produces signals, commits them to the ledger as `watchdog_signal`
   * and refreshes the inspector summary. A legitimate wait is never a stall.
   */
  private scanWatchdog(): void {
    if (!this.watchdog) return;
    const { store } = this.options;
    const now = new Date();
    const observations = store.listInflightTasks().map((item) => {
      const lastActivity = store.getEvidence<string>(item.taskId, "lastActivityAt") ?? item.updatedAt;
      const runStartedAt = store.getEvidence<string>(item.taskId, "runStartedAt") ?? null;
      const failures = store.getEvidence<string[]>(item.taskId, "recentFailures") ?? [];
      return {
        taskId: item.taskId,
        status: item.status,
        waitingReason: item.waitingReason,
        lastActivityAt: lastActivity,
        runStartedAt,
        hasProgress: store.getEvidence<boolean>(item.taskId, "hasProgress") === true,
        failureFingerprints: failures,
        changedFiles: store.getEvidence<string[]>(item.taskId, "changedFiles") ?? [],
      };
    });
    const report = this.watchdog.scan(observations, now);
    for (const summary of report.summaries) {
      store.setEvidence(summary.taskId, "watchdogStatus", summary.status, now.toISOString());
      store.setEvidence(summary.taskId, "lastHeartbeatAt", summary.lastHeartbeatAt, now.toISOString());
    }
    for (const signal of report.signals) {
      // Only the signal is committed here; triage/steering is Step 5.2's job.
      // Never enqueue a duplicate JOB_DISPATCH for an already-running task.
      this.options.writer.commit({
        taskId: signal.taskId,
        type: "watchdog_signal",
        payload: { kind: signal.kind, detail: signal.detail },
        options: {
          idempotencyKey: `watchdog:${signal.kind}:${signal.observedAt}`,
          now: signal.observedAt,
        },
      });
      this.options.log(`watchdog ${signal.kind} on ${signal.taskId}: ${signal.detail}`);
    }
  }

  /**
   * Carries out a stop: interrupts the in-flight T3 run, then finalises the task.
   * A task that never reached T3 needs no interrupt and is finalised directly, so
   * `timo stop` never leaves a task parked in `stopping` forever.
   */
  private async stopTask(taskId: string): Promise<void> {
    const { store, service, t3 } = this.options;
    const task = store.get(taskId);
    if (!task) return;
    // Only a task parked in `stopping` needs the interrupt + finalise step; any
    // other state means the stop already finished or was never requested.
    if (task.status !== "stopping") return;
    let interrupted = true;
    let message: string | undefined;
    if (task.threadId) {
      if (!t3) {
        interrupted = false;
        message = "t3 not configured; the local run was revoked but the remote thread could not be interrupted";
      } else {
        let client: T3Client | null = null;
        try {
          client = await this.connect(t3);
          const outcome = await this.withRetry(new RetryTracker(this.options.retryPolicy ?? DEFAULT_RETRY_POLICY), client, () =>
            client!.stop({ threadId: task.threadId!, runId: task.runId }),
          );
          if (!outcome.ok) {
            interrupted = false;
            message = `interrupt failed: ${outcome.error.message}`;
          }
        } catch (error) {
          interrupted = false;
          message = error instanceof Error ? error.message : String(error);
        } finally {
          await client?.close().catch(() => undefined);
        }
      }
    }
    try {
      service.markStopped(taskId, { interrupted, message });
    } catch (error) {
      this.options.log(`stop ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
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
    this.commitFailure(taskId, { reason: `run_${status}`, detail: `t3 run ended as ${status}` });
  }

  /**
   * Completes the pipeline for a `completed` run: persist the observation, move
   * to verifying, read the candidate and let the verifier decide. Shared by the
   * live dispatch path and reconciliation so the two cannot diverge.
   */
  private async finishCompletedRun(taskId: string, threadId: string, runId: string, output: unknown, retry: RetryTracker): Promise<void> {
    const { store, service } = this.options;
    const now = toIso(new Date());
    const fail = (reason: string) => this.commitFailure(taskId, { reason, detail: reason });
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
    // A task stopped while the run was finishing must not be resurrected.
    if (!current || isTerminal(current.status) || current.status === "stopping") return;
    this.options.writer.commit({
      taskId,
      type: "run_observed",
      payload: { threadId, runId, runStatus: "completed" },
      options: { idempotencyKey: `observed:${runId}:completed`, now },
      project: () => {
        store.setEvidence(taskId, "hasProgress", true, now);
        store.setEvidence(taskId, "lastActivityAt", now, now);
        store.setStatus(taskId, "verifying", null, now);
      },
    });

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
    if (!task || !this.isTaskRunnable(task)) return;
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
      this.commitFailure(taskId, { reason: "artifact_missing", detail: `frozen input missing at ${task.artifactPath}` });
      store.setOperationStatus(operation.operationId, "failed", { reason: "artifact_missing" }, now());
      return;
    }

    const startedIso = now();
    this.options.writer.commit({
      taskId,
      type: "dispatch_started",
      payload: { operationId: operation.operationId },
      options: { idempotencyKey: `dispatch:${operation.operationId}`, now: startedIso },
      project: () => {
        store.setStatus(taskId, "running", null, startedIso);
        if (!store.getEvidence<string>(taskId, "runStartedAt")) store.setEvidence(taskId, "runStartedAt", startedIso, startedIso);
        store.setEvidence(taskId, "lastActivityAt", startedIso, startedIso);
      },
    });
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
      // Activity stamp for the first-level watchdog: the run exists and has just
      // produced output from the executor's point of view.
      store.setEvidence(taskId, "lastActivityAt", now(), now());

      // 3. Bounded wait on the fixed runId. Each re-issued wait is a fresh
      //    server-side timeout, so the local deadline bounds the loop.
      const deadline = startedAt + this.options.runDeadlineMs;
      let finalStatus: string | null = null;
      while (Date.now() < deadline) {
        if (store.get(taskId)?.status === "stopping") {
          await this.stopTask(taskId);
          return;
        }
        const waited = await this.withRetry(retry, client, () =>
          client!.wait({ threadId: threadId!, runId: resolveRunId, timeoutMs: this.options.waitTimeoutMs }),
        );
        if (store.get(taskId)?.status === "stopping") {
          await this.stopTask(taskId);
          return;
        }
        if (!waited.ok) {
          this.recordFailureFingerprint(taskId, failureFingerprint(waited.error), now());
          if (waited.error.retryable) continue;
          return this.failFromError(taskId, waited.error, attemptId, "wait", { externalEffect: true });
        }
        store.setEvidence(taskId, "lastActivityAt", now(), now());
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
        this.commitFailure(taskId, {
          reason: "unexpected_error",
          detail: error instanceof Error ? error.message : String(error),
        });
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
    if (operation) store.setOperationStatus(operation.operationId, "failed", { phase, message: error.message }, now);
    this.commitFailure(taskId, { reason: `${phase}:${error.kind}`, detail: `${phase}: ${error.message}` });
  }

  /**
   * The single failure path. It commits `task_failed` with the projection and the
   * notification in one transaction, so the ledger and the task row can never
   * disagree, and SSE subscribers see the failure.
   */
  private commitFailure(taskId: string, input: { reason: string; detail: string }): void {
    const { store } = this.options;
    if (!this.isRunnable(store.get(taskId)?.status ?? "failed")) {
      // A stopped or finished task keeps its outcome; a late failure is noise.
      this.options.log(`task ${taskId}: ignoring failure after terminal state (${input.reason})`);
      return;
    }
    const now = toIso(new Date());
    this.options.writer.commit({
      taskId,
      type: "task_failed",
      payload: { reason: input.reason, detail: input.detail },
      options: { idempotencyKey: `failed:${input.reason}`, now },
      project: () => {
        store.setFailure(taskId, input.detail, now);
        store.setStatus(taskId, "failed", null, now);
        store.enqueueNotification(taskId, "task_failed", { reason: input.reason, detail: input.detail }, now);
      },
    });
  }

  private markWaiting(taskId: string, reason: WaitingReason, detail: string): void {
    const { store } = this.options;
    const now = toIso(new Date());
    const task = store.get(taskId);
    if (!task || !this.isRunnable(task.status)) return;
    // A fresh occurrence of the same reason is a distinct fact, so the counter is
    // part of the idempotency key; a replay of the same attempt is not.
    const counter = (store.getEvidence<number>(taskId, `waitCount:${reason}`) ?? 0) + 1;
    store.setEvidence(taskId, `waitCount:${reason}`, counter, now);
    let runAfter: string | undefined;
    if (reason === "t3_unavailable" || reason === "effect_unknown") {
      const delay = this.backoffFor(taskId);
      runAfter = toIso(new Date(Date.now() + delay));
      store.setEvidence(taskId, "dispatchNotBefore", runAfter, now);
    }
    this.options.writer.commit({
      taskId,
      type: "task_waiting",
      payload: { waitingReason: reason, detail, attempt: counter },
      options: {
        idempotencyKey: `waiting:${reason}:${counter}`,
        now,
      },
      project: () => {
        store.setStatus(taskId, "waiting", reason, now);
        store.enqueueNotification(taskId, `waiting_${reason}`, { waitingReason: reason, detail, attempt: counter }, now);
      },
    });
    this.options.log(`task ${reason}: ${detail}`);
  }

  /**
   * Resolves this pass's claimed outbox jobs according to the actual outcome:
   * - Terminal tasks (`completed`, `failed`, `stopped`) complete their jobs so
   *   finished work is never re-queued.
   * - Transient waits (`t3_unavailable`, `effect_unknown`) or uncaught runner
   *   exceptions retry the existing job with bounded backoff instead of marking
   *   it done or spawning duplicate jobs.
   */
  private finishClaimedJobs(taskId: string, threwError: string | null): void {
    const now = toIso(new Date());
    const task = this.options.store.get(taskId);
    const policy = this.options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    for (const job of this.claimedJobs) {
      if (job.taskId !== taskId) continue;
      if (!task || isTerminal(task.status)) {
        this.options.writer.outbox.complete(job.jobId, now);
        continue;
      }
      const needsRetry =
        threwError !== null ||
        (job.kind === JOB_DISPATCH &&
          task.status === "waiting" &&
          (task.waitingReason === "t3_unavailable" || task.waitingReason === "effect_unknown")) ||
        (job.kind === JOB_STOP && task.status === "stopping");
      if (needsRetry) {
        const reason = threwError ?? task.waitingReason ?? `still_${task.status}`;
        this.options.writer.outbox.retry(job.jobId, reason, this.backoffMs(job.taskId, policy), now);
      } else {
        this.options.writer.outbox.complete(job.jobId, now);
      }
    }
    this.claimedJobs = this.claimedJobs.filter((job) => job.taskId !== taskId);
  }

  /** Exponential backoff bounded by the retry policy. */
  private backoffMs(taskId: string, policy: RetryPolicy): number {
    const { store } = this.options;
    const previous = store.getEvidence<number>(taskId, "dispatchFailures") ?? 0;
    const count = previous + 1;
    return Math.min(policy.maxDelayMs, Math.max(policy.firstDelayMs, this.options.pollIntervalMs * 4 * 2 ** Math.min(count - 1, 6)));
  }

  private recordFailureFingerprint(taskId: string, fingerprint: string, now: string): void {
    const { store } = this.options;
    const previous = store.getEvidence<string[]>(taskId, "recentFailures") ?? [];
    store.setEvidence(taskId, "recentFailures", [...previous.slice(-9), fingerprint], now);
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
