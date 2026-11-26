import type { T3Client } from "./t3.js";
import { T3Error } from "./t3.js";
import type { ExecutionAdapter, ExecutorDescriptor, RunStreamEvent, SpawnRequest, SpawnResult } from "./execution.js";

/**
 * Adapts the existing MCP-based T3 client to the unified `ExecutionAdapter`
 * interface, preserving the behaviour proven against T3 v0.1.12: `launch` opens
 * a thread with the first prompt, `wait` observes the run.
 *
 * T3 has no incremental stream in this adapter's contract, so the adapter emits
 * coarse status events instead of inventing tool-level detail.
 */
export class T3ExecutionAdapter implements ExecutionAdapter {
  readonly id = "t3";
  private readonly runs = new Map<string, { threadId: string; runId: string; taskId: string }>();
  private readonly clientFactory: () => Promise<T3Client>;

  constructor(options: { clientFactory: () => Promise<T3Client> }) {
    this.clientFactory = options.clientFactory;
  }

  async probe(): Promise<ExecutorDescriptor> {
    try {
      const client = await this.clientFactory();
      try {
        const capabilities = await client.probe();
        return {
          id: this.id,
          kind: "mcp",
          available: true,
          reason: capabilities.providers.length > 0 ? `providers: ${capabilities.providers.join(", ")}` : undefined,
          capabilities: {
            steer: capabilities.features.threadManagement === true,
            resume: capabilities.features.incrementalThreadRead === true,
            stream: false,
          },
        };
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch (error) {
      return {
        id: this.id,
        kind: "mcp",
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        capabilities: {},
      };
    }
  }

  async spawn(request: SpawnRequest, onEvent: (event: RunStreamEvent) => void): Promise<SpawnResult> {
    const client = await this.clientFactory();
    let seq = 0;
    const emit = (type: RunStreamEvent["type"], summary: string) => {
      seq += 1;
      onEvent({ seq, runId: request.runId, taskId: request.taskId, type, at: Date.now(), summary });
    };
    try {
      emit("status", "launching t3 thread");
      const launched = await client.launch({
        title: `timo · ${request.taskId.slice(0, 8)}`,
        prompt: request.prompt,
        outputSchema: { type: "object" },
        modelSelection: { instanceId: "pi", model: request.model ?? "default" },
        clientRequestId: request.runId,
      });
      const runId = launched.runId ?? request.runId;
      this.runs.set(request.runId, { threadId: launched.threadId, runId, taskId: request.taskId });

      const deadline = Date.now() + (request.timeoutMs ?? 600_000);
      while (Date.now() < deadline) {
        const waited = await client.wait({ threadId: launched.threadId, runId, timeoutMs: 30_000 });
        if (waited.timedOut) continue;
        emit("status", `t3 run ${waited.status}`);
        const status = waited.status === "completed" ? "succeeded" : "failed";
        return {
          runId,
          externalId: launched.threadId,
          status,
          exitCode: status === "succeeded" ? 0 : 1,
          output: typeof waited.output === "string" ? waited.output : JSON.stringify(waited.output ?? ""),
        };
      }
      emit("error", "t3 run exceeded the deadline");
      return { runId, externalId: launched.threadId, status: "timed_out", exitCode: null, output: "" };
    } catch (error) {
      const message = error instanceof T3Error ? `${error.kind}: ${error.message}` : error instanceof Error ? error.message : String(error);
      emit("error", message);
      return { runId: request.runId, externalId: null, status: "failed", exitCode: null, output: "" };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** T3 keeps the run queryable, so resume re-reads the known thread/run. */
  async resume(runId: string): Promise<SpawnResult> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`run ${runId} is not known to this process; it cannot be resumed`);
    return { runId: run.runId, externalId: run.threadId, status: "failed", exitCode: null, output: "resume requires a fresh read; handled by the scheduler" };
  }

  /** T3 has no message injection into a running turn. */
  async steer(): Promise<{ accepted: boolean; reason?: string }> {
    return { accepted: false, reason: "t3 adapter does not support steering a live run" };
  }

  async interrupt(runId: string): Promise<{ interrupted: boolean; reason?: string }> {
    const run = this.runs.get(runId);
    if (!run) return { interrupted: false, reason: "run is not active" };
    const client = await this.clientFactory();
    try {
      await client.stop({ threadId: run.threadId, runId: run.runId });
      return { interrupted: true };
    } catch (error) {
      return { interrupted: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
