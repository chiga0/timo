import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
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
 * Native CLI adapter for `opencode` (`opencode run --format json`, v1.19+).
 *
 * Drives `opencode` as a mature external runtime without implementing a custom
 * agent loop:
 * - Translates `--format json` raw JSONL events (`text`, `reasoning`, `tool_use`,
 *   `step_start`, `step_finish`, `error`) into normalized `RunStreamEvent`s;
 * - Supports native session resume via `-s <sessionId>`;
 * - Strips sensitive business env vars via `buildIsolatedWorkerEnv`.
 */
export interface OpenCodeAdapterOptions {
  command?: string;
  autoApprove?: boolean;
  extraArgs?: string[];
  maxLineBytes?: number;
  summaryLimit?: number;
}

interface ActiveRun {
  child: ChildProcess;
  interrupted: boolean;
  timedOut: boolean;
}

interface KnownSession {
  sessionId: string;
  cwd: string;
  taskId: string;
  model?: string;
  mcpGatewayUrl?: string;
}

const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);

export class OpenCodeAdapter implements ExecutionAdapter {
  readonly id = "opencode";
  private readonly command: string;
  private readonly autoApprove: boolean;
  private readonly extraArgs: string[];
  private readonly maxLineBytes: number;
  private readonly summaryLimit: number;
  private readonly active = new Map<string, ActiveRun>();
  private readonly sessions = new Map<string, KnownSession>();

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.command = options.command ?? process.env.TIMO_OPENCODE_COMMAND ?? "opencode";
    this.autoApprove = options.autoApprove ?? true;
    this.extraArgs = options.extraArgs ?? [];
    this.maxLineBytes = options.maxLineBytes ?? 512 * 1024;
    this.summaryLimit = options.summaryLimit ?? 400;
  }

  async probe(): Promise<ExecutorDescriptor> {
    const resolved = resolveOnPath(this.command);
    if (!resolved) {
      return { id: this.id, kind: "cli", available: false, reason: `${this.command} not found on PATH`, capabilities: {} };
    }
    try {
      const version = execFileSync(resolved, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
      return {
        id: this.id,
        kind: "cli",
        available: true,
        reason: version === "" ? resolved : `${resolved} (${version})`,
        capabilities: { steer: false, resume: true, stream: true },
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
    return this.launch(request, null, onEvent);
  }

  async resume(runId: string, onEvent: (event: RunStreamEvent) => void, followUpPrompt = "Continue and finish verification."): Promise<SpawnResult> {
    const known = this.sessions.get(runId);
    if (!known) throw new Error(`opencode run ${runId} has no recorded session id to resume`);
    return this.launch(
      {
        taskId: known.taskId,
        runId: `${runId}-resume`,
        cwd: known.cwd,
        prompt: followUpPrompt,
        model: known.model,
        mcpGatewayUrl: known.mcpGatewayUrl,
      },
      known.sessionId,
      onEvent,
    );
  }

  async steer(): Promise<{ accepted: boolean; reason?: string }> {
    return { accepted: false, reason: "opencode run does not support mid-turn steering; use handoff or resume" };
  }

  async interrupt(runId: string): Promise<{ interrupted: boolean; reason?: string }> {
    const run = this.active.get(runId);
    if (!run) return { interrupted: false, reason: "run is not active" };
    run.interrupted = true;
    this.terminate(run.child);
    return { interrupted: true };
  }

  private async launch(
    request: SpawnRequest,
    resumeSessionId: string | null,
    onEvent: (event: RunStreamEvent) => void,
  ): Promise<SpawnResult> {
    if (!existsSync(request.cwd)) throw new Error(`cwd does not exist: ${request.cwd}`);
    const args: string[] = ["run", "--format", "json", "--dir", request.cwd];
    if (this.autoApprove) args.push("--auto");
    if (resumeSessionId) args.push("-s", resumeSessionId);
    if (request.model && request.model !== "default" && request.model !== "pending") {
      args.push("-m", request.model);
    }
    args.push(...this.extraArgs, request.prompt);

    const workerEnv = buildIsolatedWorkerEnv(process.env, {
      ...(request.mcpGatewayUrl ? { TIMO_MCP_GATEWAY_URL: request.mcpGatewayUrl } : {}),
      ...(request.env ?? {}),
    });

    const child = spawn(this.command, args, {
      cwd: request.cwd,
      env: workerEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const run: ActiveRun = { child, interrupted: false, timedOut: false };
    this.active.set(request.runId, run);

    let seq = 0;
    const emit = (type: RunStreamEventType, summary: string, data?: unknown) => {
      seq += 1;
      onEvent({ seq, runId: request.runId, taskId: request.taskId, type, at: Date.now(), summary: this.clip(summary), data });
    };
    emit("status", resumeSessionId ? `opencode resuming session ${resumeSessionId}` : "opencode started");

    let output = "";
    let externalId: string | null = resumeSessionId;
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
            const parsed = this.translate(line);
            if (!parsed) continue;
            if (parsed.sessionId) {
              externalId = parsed.sessionId;
              this.sessions.set(request.runId, {
                sessionId: parsed.sessionId,
                cwd: request.cwd,
                taskId: request.taskId,
                model: request.model,
                mcpGatewayUrl: request.mcpGatewayUrl,
              });
            }
            if (parsed.finalText !== undefined) output = parsed.finalText;
            for (const ev of parsed.events) emit(ev.type, ev.summary, ev.data);
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderrTail = (stderrTail + chunk).slice(-4000);
        });
        child.on("error", (error) => {
          emit("error", `opencode process error: ${error.message}`);
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
      emit("error", stderrTail.trim() !== "" ? stderrTail.trim() : `opencode exited with ${exitCode ?? "signal"}`);
    }
    emit("status", `opencode ${status}`);
    return { runId: request.runId, externalId, status, exitCode, output };
  }

  private translate(line: string): {
    events: Array<{ type: RunStreamEventType; summary: string; data?: unknown }>;
    sessionId?: string;
    finalText?: string;
  } | null {
    const trimmed = line.trim();
    if (trimmed === "") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { events: [{ type: "shell", summary: trimmed }] };
    }
    const record = parsed as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const sessionId =
      typeof record.sessionID === "string"
        ? record.sessionID
        : typeof record.session_id === "string"
          ? record.session_id
          : undefined;
    const part = (record.part && typeof record.part === "object" ? (record.part as Record<string, unknown>) : record);

    if (type === "text" || part.type === "text") {
      const text = typeof part.text === "string" ? part.text.trim() : "";
      if (text === "") return sessionId ? { sessionId, events: [] } : null;
      return { sessionId, finalText: text, events: [{ type: "thinking", summary: text }] };
    }
    if (type === "reasoning" || part.type === "reasoning") {
      const text = typeof part.text === "string" ? part.text.trim() : "";
      if (text === "") return null;
      return { sessionId, events: [{ type: "thinking", summary: text }] };
    }
    if (type === "tool_use" || part.type === "tool") {
      const tool = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : "tool";
      const state = part.state as Record<string, unknown> | undefined;
      const input = state?.input ?? part.input;
      const events: Array<{ type: RunStreamEventType; summary: string; data?: unknown }> = [];
      events.push({ type: "tool_call", summary: formatTool(tool, input), data: input });
      if (EDIT_TOOLS.has(tool.toLowerCase()) && input && typeof input === "object") {
        const file = (input as Record<string, unknown>).filePath ?? (input as Record<string, unknown>).path;
        if (typeof file === "string" && file.trim() !== "") {
          events.push({ type: "patch", summary: `modified ${file.trim()}`, data: { files: [file.trim()] } });
        }
      }
      if (state?.status === "completed" && state.output !== undefined) {
        events.push({ type: "tool_result", summary: typeof state.output === "string" ? state.output : JSON.stringify(state.output) });
      } else if (state?.status === "error") {
        events.push({ type: "error", summary: String(state.error ?? "tool failed") });
      }
      return { sessionId, events };
    }
    if (type === "step_start" || type === "step_finish") {
      return { sessionId, events: [{ type: "status", summary: type }] };
    }
    if (type === "error") {
      const msg = typeof record.error === "string" ? record.error : JSON.stringify(record.error ?? record.message ?? trimmed);
      return { sessionId, events: [{ type: "error", summary: msg }] };
    }
    return { sessionId, events: [{ type: "status", summary: type || "opencode_event", data: record }] };
  }

  private clip(text: string): string {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length > this.summaryLimit ? `${clean.slice(0, this.summaryLimit)}…` : clean;
  }

  private terminate(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
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

function formatTool(name: string, input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    const target = rec.filePath ?? rec.path ?? rec.command;
    if (typeof target === "string" && target.trim() !== "") return `${name}(${target.trim()})`;
  }
  return name;
}

function resolveOnPath(command: string): string | null {
  if (command.includes("/")) return existsSync(command) ? command : null;
  try {
    return execFileSync("sh", ["-c", `command -v ${JSON.stringify(command)}`], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}
