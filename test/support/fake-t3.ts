import type { T3Client, T3ClientFactory, ThreadReading } from "../../src/adapters/t3.js";
import { T3Error } from "../../src/adapters/t3.js";

export interface FakeRun {
  threadId: string;
  runId: string;
  /** Reply text the fake run returns. */
  text?: string;
  structured?: unknown;
  /** Final status of the run. Defaults to completed. */
  status?: "completed" | "failed" | "interrupted";
  /** Wait calls that time out before the run finishes. */
  waittimeouts?: number;
  /** Behaviour on the next call, then cleared. */
  failNext?: T3Error;
  /** Deterministic delay before the run reaches a terminal state. */
  delayMs?: number;
}

/**
 * In-memory replacement for the MCP transport. It records every call so tests
 * can assert the outbound order and the stable client request ids.
 */
export class FakeT3 implements T3Client {
  readonly calls: string[] = [];
  readonly launches: Array<{ title: string; projectId: string | null }> = [];
  readonly submissions: Array<{ threadId: string; clientRequestId: string; outputSchema: unknown; prompt: string }> = [];
  readonly reads: Array<{ threadId: string; runId: string }> = [];
  readonly stops: Array<{ threadId: string; runId: string | null }> = [];
  private threadSeq = 0;
  private runSeq = 0;
  runs = new Map<string, FakeRun>();
  /** When set, every call fails with this error. */
  failAll: T3Error | null = null;
  /** Simulates a lost reply after the server actually created the object. */
  loseLaunchReplyOnce = false;
  loseSendReplyOnce = false;

  static factory(fake: FakeT3): T3ClientFactory {
    return () => fake as never;
  }

  async probe() {
    this.calls.push("probe");
    return { environmentId: null, providers: ["fake"], features: { threadManagement: true } };
  }

  /**
   * v0.1.12 has no separate "prepare an empty thread" call; a thread is created
   * together with its first prompt via `launch`. Kept so tests written against
   * the older interface still compile, and it records the same call.
   */
  async prepareThread(input: { title: string; projectId: string | null }) {
    this.calls.push("prepare");
    this.throwIfFailing();
    this.launches.push(input);
    this.threadSeq++;
    return { threadId: `thread-${this.threadSeq}` };
  }

  async launch(input: { title: string; prompt: string; outputSchema: unknown; modelSelection: { instanceId: string; model: string }; clientRequestId: string }) {
    this.calls.push("launch");
    this.throwIfFailing();
    this.launches.push({ title: input.title, projectId: null });
    this.submissions.push({ threadId: "", clientRequestId: input.clientRequestId, outputSchema: input.outputSchema, prompt: input.prompt });
    this.threadSeq++;
    this.runSeq++;
    const threadId = `thread-${this.threadSeq}`;
    const runId = `run-${this.runSeq}`;
    this.runs.set(`${threadId}:${runId}`, { threadId, runId });
    if (this.loseLaunchReplyOnce) {
      this.loseLaunchReplyOnce = false;
      throw new T3Error("timeout", "launch reply lost");
    }
    return { threadId, runId, status: "running" };
  }

  async send(input: { threadId: string; prompt: string; outputSchema: unknown; clientRequestId: string }) {
    this.calls.push("send");
    this.throwIfFailing();
    this.submissions.push(input);
    this.runSeq++;
    const runId = `run-${this.runSeq}`;
    this.runs.set(`${input.threadId}:${runId}`, { threadId: input.threadId, runId });
    if (this.loseSendReplyOnce) {
      this.loseSendReplyOnce = false;
      throw new T3Error("timeout", "send reply lost");
    }
    return { runId, messageId: `msg-${this.runSeq}`, status: "queued" };
  }

  async wait(input: { threadId: string; runId: string; timeoutMs: number }) {
    this.calls.push("wait");
    this.throwIfFailing();
    const run = this.runs.get(`${input.threadId}:${input.runId}`);
    if (!run) throw new T3Error("tool_error", `unknown run ${input.runId}`);
    if (run.failNext) {
      const error = run.failNext;
      run.failNext = undefined;
      throw error;
    }
    if (run.waittimeouts && run.waittimeouts > 0) {
      run.waittimeouts--;
      return { status: "running", timedOut: true };
    }
    if (run.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, run.delayMs));
    }
    return { status: run.status ?? "completed", timedOut: false, output: run.structured };
  }

  async read(input: { threadId: string; runId: string }): Promise<ThreadReading> {
    this.calls.push("read");
    this.reads.push(input);
    this.throwIfFailing();
    const run = this.runs.get(`${input.threadId}:${input.runId}`);
    if (!run) throw new T3Error("tool_error", `unknown run ${input.runId}`);
    const text = run.text ?? (run.structured === undefined ? null : JSON.stringify(run.structured));
    return {
      threadStatus: "idle",
      runStatus: run.status ?? "completed",

      assistantText: text ?? undefined,
      items: text ? [{ type: "assistant_message", runId: input.runId, status: "completed", text, position: 1 }] : [],
    };
  }

  async stop(input: { threadId: string; runId: string | null }) {
    this.calls.push("stop");
    this.stops.push(input);
    return { status: "interrupt_requested" };
  }

  async close() {
    this.throwIfFailing();
  }

  private throwIfFailing(): void {
    if (this.failAll) throw this.failAll;
  }
}
