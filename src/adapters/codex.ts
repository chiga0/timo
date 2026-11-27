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
 * Native CLI adapter for OpenAI `codex` (`codex exec --json`, v0.149+).
 *
 * Drives `codex` as a mature external runtime without implementing a custom
 * agent loop:
 * - Translates `codex exec --json` JSONL (`thread.started`, `item.started`,
 *   `item.completed`, `turn.completed`, `error`) into normalized `RunStreamEvent`s;
 * - Mounts Timo's scoped Capability MCP Gateway via `-c mcp_servers.timo.url=...`;
 * - Supports native session resume via `codex exec resume <threadId>`;
 * - Strips sensitive business env vars via `buildIsolatedWorkerEnv`.
 */
export interface CodexAdapterOptions {
  command?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
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
  threadId: string;
  cwd: string;
  taskId: string;
  model?: string;
  mcpGatewayUrl?: string;
}

export class CodexAdapter implements ExecutionAdapter {
  readonly id = "codex";
  private readonly command: string;
  private readonly sandbox: NonNullable<CodexAdapterOptions["sandbox"]>;
  private readonly extraArgs: string[];
  private readonly maxLineBytes: number;
  private readonly summaryLimit: number;
  private readonly active = new Map<string, ActiveRun>();
  private readonly sessions = new Map<string, KnownSession>();

  constructor(options: CodexAdapterOptions = {}) {
    this.command = options.command ?? process.env.TIMO_CODEX_COMMAND ?? "codex";
    this.sandbox = options.sandbox ?? "workspace-write";
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
        capabilities: { steer: false, resume: true, stream: true, mcpGateway: true },
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
    if (!known) throw new Error(`codex run ${runId} has no recorded thread id to resume`);
    return this.launch(
      {
        taskId: known.taskId,
        runId: `${runId}-resume`,
        cwd: known.cwd,
        prompt: followUpPrompt,
        model: known.model,
        mcpGatewayUrl: known.mcpGatewayUrl,
      },
      known.threadId,
      onEvent,
    );
  }

  async steer(): Promise<{ accepted: boolean; reason?: string }> {
    return { accepted: false, reason: "codex exec does not support mid-turn steering; use handoff or resume" };
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
    resumeThreadId: string | null,
    onEvent: (event: RunStreamEvent) => void,
  ): Promise<SpawnResult> {
    if (!existsSync(request.cwd)) throw new Error(`cwd does not exist: ${request.cwd}`);
    const args: string[] = ["exec"];
    if (resumeThreadId) {
      args.push("resume", "--json");
      if (request.model && request.model !== "default" && request.model !== "pending") {
        args.push("-c", `model=${JSON.stringify(request.model)}`);
      }
      if (request.mcpGatewayUrl) {
        args.push("-c", `mcp_servers.timo.url=${JSON.stringify(request.mcpGatewayUrl)}`);
      }
      args.push(...this.extraArgs, resumeThreadId, request.prompt);
    } else {
      args.push("--json", "-C", request.cwd, "--sandbox", this.sandbox, "--skip-git-repo-check");
      if (request.model && request.model !== "default" && request.model !== "pending") {
        args.push("-m", request.model);
      }
      if (request.mcpGatewayUrl) {
        args.push("-c", `mcp_servers.timo.url=${JSON.stringify(request.mcpGatewayUrl)}`);
      }
      args.push(...this.extraArgs, request.prompt);
    }

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
      const normalized = type === "text_delta" ? summary : this.clip(summary);
      onEvent({ seq, runId: request.runId, taskId: request.taskId, type, at: Date.now(), summary: normalized, data });
    };
    emit("status", resumeThreadId ? `codex resuming thread ${resumeThreadId}` : "codex started");

    let output = "";
    let externalId: string | null = resumeThreadId;
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
            if (parsed.threadId) {
              externalId = parsed.threadId;
              this.sessions.set(request.runId, {
                threadId: parsed.threadId,
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
          emit("error", `codex process error: ${error.message}`);
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
      emit("error", stderrTail.trim() !== "" ? stderrTail.trim() : `codex exited with ${exitCode ?? "signal"}`);
    }
    emit("status", `codex ${status}`);
    return { runId: request.runId, externalId, status, exitCode, output };
  }

  private translate(line: string): {
    events: Array<{ type: RunStreamEventType; summary: string; data?: unknown }>;
    threadId?: string;
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

    if (type === "thread.started") {
      const threadId = typeof record.thread_id === "string" ? record.thread_id : undefined;
      return { threadId, events: [{ type: "status", summary: `thread started${threadId ? ` (${threadId})` : ""}` }] };
    }
    if (type === "turn.started") return { events: [{ type: "status", summary: "turn started" }] };
    if (type === "turn.completed") return { events: [{ type: "status", summary: "turn completed", data: record.usage }] };
    if (type === "error" || type === "turn.failed") {
      const msg =
        typeof record.message === "string"
          ? record.message
          : typeof (record.error as { message?: unknown } | undefined)?.message === "string"
            ? String((record.error as { message: string }).message)
            : trimmed;
      return { events: [{ type: "error", summary: msg }] };
    }

    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      const item = record.item as Record<string, unknown> | undefined;
      if (!item) return null;
      const itemType = typeof item.type === "string" ? item.type : "";
      if (itemType === "agent_message" && typeof item.text === "string" && item.text.trim() !== "") {
        return { finalText: item.text, events: [{ type: "thinking", summary: item.text }] };
      }
      if (itemType === "reasoning" && typeof item.text === "string" && item.text.trim() !== "") {
        return { events: [{ type: "thinking", summary: item.text }] };
      }
      if (itemType === "command_execution") {
        const cmd = typeof item.command === "string" ? item.command : "shell";
        if (type === "item.started") return { events: [{ type: "tool_call", summary: `shell(${cmd})`, data: { command: cmd } }] };
        const out = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
        return { events: [{ type: "shell", summary: out || `${cmd} (exit=${String(item.exit_code ?? 0)})` }] };
      }
      if (itemType === "file_change") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const files = changes
          .map((c) => (c && typeof c === "object" ? (c as { path?: unknown }).path : null))
          .filter((p): p is string => typeof p === "string");
        return { events: [{ type: "patch", summary: `changed ${files.join(", ") || "files"}`, data: { files } }] };
      }
      if (itemType === "mcp_tool_call") {
        const tool = typeof item.tool === "string" ? item.tool : "mcp_tool";
        if (type === "item.started") return { events: [{ type: "tool_call", summary: tool, data: item.arguments }] };
        return { events: [{ type: "tool_result", summary: JSON.stringify(item.result ?? item.error ?? "ok") }] };
      }
    }

    return { events: [{ type: "status", summary: type || "codex_event", data: record }] };
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

function resolveOnPath(command: string): string | null {
  if (command.includes("/")) return existsSync(command) ? command : null;
  try {
    return execFileSync("sh", ["-c", `command -v ${JSON.stringify(command)}`], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}
