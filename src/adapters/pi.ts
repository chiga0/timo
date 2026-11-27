import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  buildIsolatedWorkerEnv,
  type ExecutionAdapter,
  type ExecutorDescriptor,
  type RunStreamEvent,
  type RunStreamEventType,
  type SpawnRequest,
  type SpawnResult,
} from "./execution.js";

/**
 * Native CLI executor for `pi` (Pi), driving it as a mature runtime rather than
 * re-implementing an agent loop.
 *
 * `pi -p --mode json` prints one JSON object per line: `session`, `agent_start`,
 * `message`, the final assistant message, then `agent_settled`. We translate
 * that into normalised `RunStreamEvent`s and never fabricate progress.
 */
export interface PiAdapterOptions {
  /** Command to run; defaults to `pi` resolved from PATH. */
  command?: string;
  /** Extra args prepended before the mode flags (e.g. `--provider pai-eas`). */
  extraArgs?: string[];
  /** Per-line limit so a pathological output cannot exhaust memory. */
  maxLineBytes?: number;
  /** Summary length cap for the inspector. */
  summaryLimit?: number;
}

interface ActiveRun {
  child: ChildProcess;
  interrupted: boolean;
  timedOut: boolean;
}

export class PiAdapter implements ExecutionAdapter {
  readonly id = "pi";
  private readonly command: string;
  private readonly extraArgs: string[];
  private readonly maxLineBytes: number;
  private readonly summaryLimit: number;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: PiAdapterOptions = {}) {
    this.command = options.command ?? "pi";
    this.extraArgs = options.extraArgs ?? [];
    this.maxLineBytes = options.maxLineBytes ?? 256 * 1024;
    this.summaryLimit = options.summaryLimit ?? 400;
  }

  async probe(): Promise<ExecutorDescriptor> {
    const resolved = resolveOnPath(this.command);
    if (!resolved) {
      return { id: this.id, kind: "cli", available: false, reason: `${this.command} not found on PATH`, capabilities: {} };
    }
    try {
      // `--version` is the cheapest liveness check that does not start a model.
      const version = execFileSync(resolved, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
      return {
        id: this.id,
        kind: "cli",
        available: true,
        reason: version === "" ? undefined : `${resolved} (${version})`,
        capabilities: { steer: false, resume: false, stream: true },
      };
    } catch (error) {
      return {
        id: this.id,
        kind: "cli",
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        capabilities: {},
      };
    }
  }

  async spawn(request: SpawnRequest, onEvent: (event: RunStreamEvent) => void): Promise<SpawnResult> {
    if (!existsSync(request.cwd)) throw new Error(`cwd does not exist: ${request.cwd}`);
    const args = [...this.extraArgs, "-p", "--mode", "json"];
    if (request.model) args.push("--model", request.model);
    args.push(request.prompt);

    const workerEnv = buildIsolatedWorkerEnv(process.env, {
      ...(request.mcpGatewayUrl ? { TIMO_MCP_GATEWAY_URL: request.mcpGatewayUrl } : {}),
      ...(request.env ?? {}),
    });

    const child = spawn(this.command, args, {
      cwd: request.cwd,
      env: workerEnv,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so an interrupt can signal the whole tree without
      // ever reaching this service's own group.
      detached: true,
    });
    const run: ActiveRun = { child, interrupted: false, timedOut: false };
    this.active.set(request.runId, run);

    let seq = 0;
    const emit = (type: RunStreamEventType, summary: string, data?: unknown) => {
      seq += 1;
      onEvent({ seq, runId: request.runId, taskId: request.taskId, type, at: Date.now(), summary: this.clip(summary), data });
    };
    emit("status", "executor started");

    let output = "";
    let externalId: string | null = null;
    let stderrTail = "";

    const timer =
      request.timeoutMs && request.timeoutMs > 0
        ? setTimeout(() => {
            run.timedOut = true;
            this.terminate(child);
          }, request.timeoutMs)
        : null;

    try {
      await new Promise<void>((resolve) => {
        let buffer = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.length > this.maxLineBytes) {
              emit("error", `oversized output line (${line.length} bytes) dropped`);
              continue;
            }
            const parsed = this.translate(line, request);
            if (!parsed) continue;
            if (parsed.externalId) externalId = parsed.externalId;
            if (parsed.finalText) output = parsed.finalText;
            for (const event of parsed.events) emit(event.type, event.summary, event.data);
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderrTail = (stderrTail + chunk).slice(-4000);
        });
        child.on("error", (error) => {
          emit("error", `executor process error: ${error.message}`);
          resolve();
        });
        child.on("close", () => resolve());
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.active.delete(request.runId);
    }

    const exitCode = child.exitCode;
    const status = run.timedOut ? "timed_out" : run.interrupted ? "interrupted" : exitCode === 0 ? "succeeded" : "failed";
    if (status !== "succeeded") {
      emit("error", stderrTail.trim() !== "" ? stderrTail.trim() : `executor exited with ${exitCode ?? "signal"}`);
    }
    emit("status", `executor ${status}`);
    return { runId: request.runId, externalId, status, exitCode, output };
  }

  /**
   * Pi does not expose session resume for a finished process, so re-attaching is
   * an explicit refusal rather than a silent re-run (which would double-charge).
   */
  async resume(): Promise<SpawnResult> {
    throw new Error("pi adapter cannot resume a run; start a new run instead");
  }

  /** Pi has no message-injection channel while a prompt is running. */
  async steer(): Promise<{ accepted: boolean; reason?: string }> {
    return { accepted: false, reason: "pi adapter does not support steering a live run" };
  }

  async interrupt(runId: string): Promise<{ interrupted: boolean; reason?: string }> {
    const run = this.active.get(runId);
    if (!run) return { interrupted: false, reason: "run is not active" };
    run.interrupted = true;
    // Same termination path as the timeout branch: the whole process group, so a
    // shell holding the stdout pipe cannot keep `close` from firing.
    this.terminate(run.child);
    return { interrupted: true };
  }

  /**
   * Translates one JSONL line. Returns null for lines that carry no user-visible
   * meaning (e.g. the tool catalogue dump in the `session` event).
   */
  private translate(
    line: string,
    _request: SpawnRequest,
  ): { events: Array<{ type: RunStreamEventType; summary: string; data?: unknown }>; externalId?: string; finalText?: string } | null {
    const trimmed = line.trim();
    if (trimmed === "") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Non-JSON output on stdout still tells the operator something happened.
      return { events: [{ type: "shell", summary: trimmed }] };
    }
    const record = parsed as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";

    if (type === "session") {
      return { externalId: typeof record.id === "string" ? record.id : undefined, events: [{ type: "status", summary: "session started" }] };
    }
    if (type === "agent_start") return { events: [{ type: "status", summary: "agent started" }] };
    if (type === "agent_settled") return { events: [{ type: "status", summary: "agent settled" }] };
    if (type === "message") {
      const message = record.message as Record<string, unknown> | undefined;
      const role = typeof message?.role === "string" ? message.role : "assistant";
      const content = Array.isArray(message?.content) ? message!.content : [];
      const texts: string[] = [];
      const events: Array<{ type: RunStreamEventType; summary: string; data?: unknown }> = [];
      for (const part of content) {
        const block = part as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (block.type === "tool_use" || block.type === "tool_call") {
          const name = typeof block.name === "string" ? block.name : "tool";
          events.push({ type: "tool_call", summary: name, data: block.input ?? block.arguments });
        } else if (block.type === "tool_result") {
          const summary = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
          events.push({ type: "tool_result", summary });
        }
      }
      const text = texts.join("\n").trim();
      if (text !== "") {
        if (role === "assistant") events.push({ type: "thinking", summary: text });
        else events.push({ type: "status", summary: `[${role}] ${text}` });
      }
      if (events.length === 0) return null;
      return { events, finalText: role === "assistant" && text !== "" ? text : undefined };
    }
    // Unknown event shapes are recorded verbatim so nothing is silently dropped.
    return { events: [{ type: "status", summary: type || "unknown", data: record }] };
  }

  private clip(text: string): string {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length > this.summaryLimit ? `${clean.slice(0, this.summaryLimit)}…` : clean;
  }

  /**
   * Terminates the whole process group. Killing only the direct child leaves its
   * own children (a shell running `sleep`, a tool subprocess) holding the stdout
   * pipe, so the `close` event never fires and an interrupt would hang forever.
   */
  private terminate(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      // Fall back to the direct handle if the group is already gone.
      child.kill("SIGTERM");
    }
    // Escalate if the group ignores SIGTERM.
    const escalate = setTimeout(() => {
      try {
        if (child.pid !== undefined && child.exitCode === null) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }, 2_000);
    escalate.unref?.();
  }
}

function resolveOnPath(command: string): string | null {
  if (command.includes("/")) return existsSync(command) ? command : null;
  try {
    return execFileSync("sh", ["-c", `command -v ${JSON.stringify(command)}`], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}
