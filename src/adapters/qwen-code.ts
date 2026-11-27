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
 * Native CLI adapter for local `qwen` / `qwen-code` (v0.25+).
 *
 * Integrates `qwen-code` as a mature external runtime without re-implementing
 * an agent loop:
 * - Bidirectional `--input-format stream-json -o stream-json` for live
 *   normalised `RunStreamEvent` output AND live mid-run `steer()` injection;
 * - Native `--mcp-config` injection mounting Timo's scoped local Capability
 *   MCP Gateway (`httpUrl`);
 * - Native `--resume <sessionId>` support;
 * - Physical credential isolation via `buildIsolatedWorkerEnv`.
 */
export interface QwenCodeAdapterOptions {
  /** Binary path or command name; defaults to `qwen` (falls back to `qwen-code`). */
  command?: string;
  /** Approval mode for headless worktree runs; defaults to `yolo` inside isolated worktrees. */
  approvalMode?: "plan" | "default" | "auto-edit" | "auto" | "yolo";
  /** Optional extra CLI flags prepended before mode flags. */
  extraArgs?: string[];
  /** Per-line cap to prevent pathological output from exhausting memory. */
  maxLineBytes?: number;
  /** Summary truncation limit for inspector display. */
  summaryLimit?: number;
}

interface ActiveRun {
  child: ChildProcess;
  sessionId: string;
  cwd: string;
  interrupted: boolean;
  timedOut: boolean;
  pendingTurns: number;
}

interface KnownSession {
  sessionId: string;
  cwd: string;
  taskId: string;
  model?: string;
  mcpGatewayUrl?: string;
  timeoutMs?: number;
}

const EDIT_TOOL_NAMES = new Set([
  "edit",
  "edit_file",
  "replace",
  "write_file",
  "write_to_file",
  "multi_edit",
  "create_file",
  "patch_file",
]);

export class QwenCodeAdapter implements ExecutionAdapter {
  readonly id = "qwen-code";
  private readonly command: string;
  private readonly approvalMode: NonNullable<QwenCodeAdapterOptions["approvalMode"]>;
  private readonly extraArgs: string[];
  private readonly maxLineBytes: number;
  private readonly summaryLimit: number;
  private readonly active = new Map<string, ActiveRun>();
  private readonly sessions = new Map<string, KnownSession>();

  constructor(options: QwenCodeAdapterOptions = {}) {
    this.command = options.command ?? process.env.TIMO_QWEN_COMMAND ?? "qwen";
    this.approvalMode = options.approvalMode ?? "yolo";
    this.extraArgs = options.extraArgs ?? [];
    this.maxLineBytes = options.maxLineBytes ?? 512 * 1024;
    this.summaryLimit = options.summaryLimit ?? 400;
  }

  async probe(): Promise<ExecutorDescriptor> {
    const resolved = resolveBinary(this.command);
    if (!resolved) {
      return {
        id: this.id,
        kind: "cli",
        available: false,
        reason: `${this.command} not found on PATH`,
        capabilities: {},
      };
    }
    try {
      const version = execFileSync(resolved, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
      return {
        id: this.id,
        kind: "cli",
        available: true,
        reason: version === "" ? resolved : `${resolved} (${version})`,
        capabilities: { steer: true, resume: true, stream: true, mcpGateway: true },
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

  /**
   * Resumes a previously observed `qwen-code` session using `--resume <sessionId>`.
   */
  async resume(runId: string, onEvent: (event: RunStreamEvent) => void, followUpPrompt = "Continue the task and finish verification."): Promise<SpawnResult> {
    const known = this.sessions.get(runId);
    if (!known) {
      throw new Error(`qwen-code run ${runId} has no recorded session id to resume`);
    }
    return this.launch(
      {
        taskId: known.taskId,
        runId: `${runId}-resume`,
        cwd: known.cwd,
        prompt: followUpPrompt,
        model: known.model,
        mcpGatewayUrl: known.mcpGatewayUrl,
        timeoutMs: known.timeoutMs,
      },
      known.sessionId,
      onEvent,
    );
  }

  /**
   * Injects a live steering message over stdin (`--input-format stream-json`)
   * into an active `qwen-code` session.
   */
  async steer(runId: string, message: string): Promise<{ accepted: boolean; reason?: string }> {
    const run = this.active.get(runId);
    if (!run) return { accepted: false, reason: "run is not active" };
    if (!run.child.stdin || !run.child.stdin.writable || run.child.stdin.writableEnded) {
      return { accepted: false, reason: "qwen-code stdin is already closed" };
    }
    run.pendingTurns += 1;
    const frame = {
      type: "user",
      session_id: run.sessionId,
      message: { role: "user", content: message },
      parent_tool_use_id: null,
    };
    run.child.stdin.write(`${JSON.stringify(frame)}\n`);
    return { accepted: true };
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
    const binary = resolveBinary(this.command) ?? this.command;
    const args: string[] = [
      ...this.extraArgs,
      "--input-format",
      "stream-json",
      "-o",
      "stream-json",
      "--include-partial-messages",
      "--approval-mode",
      this.approvalMode,
    ];
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }
    if (request.model && request.model !== "default" && request.model !== "pending") {
      args.push("--model", request.model);
    }
    if (request.mcpGatewayUrl) {
      args.push(
        "--mcp-config",
        JSON.stringify({
          mcpServers: {
            timo: { httpUrl: request.mcpGatewayUrl },
          },
        }),
      );
    }
    if (request.timeoutMs && request.timeoutMs > 0) {
      args.push("--max-wall-time", `${Math.max(1, Math.ceil(request.timeoutMs / 1000))}s`);
    }

    const workerEnv = buildIsolatedWorkerEnv(process.env, {
      QWEN_CODE_SUPPRESS_YOLO_WARNING: "1",
      ...(request.mcpGatewayUrl ? { TIMO_MCP_GATEWAY_URL: request.mcpGatewayUrl } : {}),
      ...(request.env ?? {}),
    });

    const child = spawn(binary, args, {
      cwd: request.cwd,
      env: workerEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    const run: ActiveRun = {
      child,
      sessionId: resumeSessionId ?? request.runId,
      cwd: request.cwd,
      interrupted: false,
      timedOut: false,
      pendingTurns: 1,
    };
    this.active.set(request.runId, run);

    let seq = 0;
    const emit = (type: RunStreamEventType, summary: string, data?: unknown) => {
      seq += 1;
      const normalized = type === "text_delta" ? summary : this.clip(summary);
      onEvent({ seq, runId: request.runId, taskId: request.taskId, type, at: Date.now(), summary: normalized, data });
    };
    emit("status", resumeSessionId ? `qwen-code resuming session ${resumeSessionId}` : "qwen-code started");

    // Feed initial user turn via stream-json stdin so steering can append follow-up turns.
    const initialFrame = {
      type: "user",
      session_id: run.sessionId,
      message: { role: "user", content: request.prompt },
      parent_tool_use_id: null,
    };
    child.stdin.on("error", () => undefined);
    child.stdin.write(`${JSON.stringify(initialFrame)}\n`);

    let output = "";
    let externalId: string | null = resumeSessionId;
    let stderrTail = "";
    let resultError: string | null = null;
    let settledAfterResult = false;
    let postResultTimer: NodeJS.Timeout | null = null;

    const timer =
      request.timeoutMs && request.timeoutMs > 0
        ? setTimeout(() => {
            run.timedOut = true;
            this.terminate(child);
          }, request.timeoutMs + 5_000)
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
              run.sessionId = parsed.sessionId;
              this.sessions.set(request.runId, {
                sessionId: parsed.sessionId,
                cwd: request.cwd,
                taskId: request.taskId,
                model: request.model,
                mcpGatewayUrl: request.mcpGatewayUrl,
                timeoutMs: request.timeoutMs,
              });
            }
            if (parsed.finalText !== undefined) output = parsed.finalText;
            if (parsed.errorText) resultError = parsed.errorText;
            for (const ev of parsed.events) emit(ev.type, ev.summary, ev.data);
            if (parsed.turnFinished) {
              run.pendingTurns = Math.max(0, run.pendingTurns - 1);
              if (run.pendingTurns === 0) {
                if (child.stdin.writable && !child.stdin.writableEnded) {
                  child.stdin.end();
                }
                // HTTP MCP transports can keep qwen's event loop alive for 30-60s
                // even after emitting the final `result` frame. Give it 1.5s to exit
                // cleanly on its own, then terminate gracefully and mark succeeded.
                if (postResultTimer) clearTimeout(postResultTimer);
                postResultTimer = setTimeout(() => {
                  if (run.pendingTurns === 0 && child.exitCode === null && child.signalCode === null) {
                    settledAfterResult = true;
                    this.terminate(child);
                  }
                }, 1_500);
                postResultTimer.unref?.();
              }
            }
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderrTail = (stderrTail + chunk).slice(-4000);
        });
        child.on("error", (error) => {
          emit("error", `qwen-code process error: ${error.message}`);
          resolve();
        });
        child.on("close", () => resolve());
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (postResultTimer) clearTimeout(postResultTimer);
      this.active.delete(request.runId);
    }

    const exitCode = child.exitCode;
    const cleanedStderr = sanitizeQwenStderr(stderrTail);
    const hitWallClock =
      run.timedOut ||
      /wall-clock budget .* exceeded|--max-wall-time/i.test(resultError ?? "") ||
      /wall-clock budget .* exceeded|--max-wall-time/i.test(cleanedStderr);
    const status = hitWallClock
      ? "timed_out"
      : run.interrupted
        ? "interrupted"
        : (exitCode === 0 || settledAfterResult) && !resultError
          ? "succeeded"
          : "failed";
    if (status !== "succeeded") {
      const detail =
        resultError ?? (cleanedStderr !== "" ? cleanedStderr : `qwen-code exited with ${exitCode ?? "signal"}`);
      emit("error", detail);
    }
    emit("status", `qwen-code ${status}`);
    return { runId: request.runId, externalId, status, exitCode, output };
  }

  private translate(line: string): {
    events: Array<{ type: RunStreamEventType; summary: string; data?: unknown }>;
    sessionId?: string;
    finalText?: string;
    errorText?: string;
    turnFinished?: boolean;
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
    const sessionId = typeof record.session_id === "string" ? record.session_id : undefined;

    if (type === "system") {
      const subtype = typeof record.subtype === "string" ? record.subtype : "system";
      const model = typeof record.model === "string" ? ` · model=${record.model}` : "";
      const version = typeof record.qwen_code_version === "string" ? ` v${record.qwen_code_version}` : "";
      return {
        sessionId,
        events: [{ type: "status", summary: `system:${subtype}${version}${model}`, data: { mcpServers: record.mcp_servers } }],
      };
    }

    if (type === "assistant") {
      const message = record.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message!.content : [];
      const events: Array<{ type: RunStreamEventType; summary: string; data?: unknown }> = [];
      const texts: string[] = [];
      let hasToolUse = false;
      for (const item of content) {
        const block = item as Record<string, unknown>;
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() !== "") {
          events.push({ type: "thinking", summary: block.thinking });
        } else if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
          texts.push(block.text);
        } else if (block.type === "tool_use") {
          hasToolUse = true;
          const name = typeof block.name === "string" ? block.name : "tool";
          const input = block.input;
          events.push({ type: "tool_call", summary: formatToolCallSummary(name, input), data: input });
          const editedFile = extractEditedFile(name, input);
          if (editedFile) {
            events.push({ type: "patch", summary: `modified ${editedFile}`, data: { files: [editedFile] } });
          }
        }
      }
      const joined = texts.join("\n").trim();
      if (joined !== "") {
        events.push({ type: "thinking", summary: joined, data: { fullText: joined } });
        // When an assistant turn finishes writing prose with no follow-up tool call,
        // emit an explicit settling status so the UI stays informative during CLI teardown.
        if (!hasToolUse) {
          events.push({ type: "status", summary: "已生成结论正文，等待执行器收尾…" });
        }
      }
      if (events.length === 0) return sessionId ? { sessionId, events: [] } : null;
      return { sessionId, events, finalText: joined !== "" ? joined : undefined };
    }

    if (type === "user") {
      const message = record.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message!.content : [];
      const events: Array<{ type: RunStreamEventType; summary: string; data?: unknown }> = [];
      for (const item of content) {
        const block = item as Record<string, unknown>;
        if (block.type === "tool_result") {
          const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
          // Keep non-zero tool outputs (e.g. grep exit 1) as `tool_result` so they stay
          // visible in step details without falsely tripping Watchdog's failure-loop counter.
          events.push({
            type: "tool_result",
            summary: text || "tool_result",
            ...(block.is_error ? { data: { isError: true } } : {}),
          });
        }
      }
      return events.length > 0 ? { sessionId, events } : null;
    }

    if (type === "stream_event") {
      const inner = record.event as Record<string, unknown> | undefined;
      if (inner?.type === "content_block_delta") {
        const delta = inner.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
          return { sessionId, events: [{ type: "text_delta", summary: delta.text, data: { delta: delta.text } }] };
        }
        if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.trim() !== "") {
          return { sessionId, events: [{ type: "thinking", summary: delta.thinking }] };
        }
      }
      if (inner?.type === "tool_progress") {
        const content = inner.content as Record<string, unknown> | undefined;
        const text = typeof content?.output === "string" ? content.output : JSON.stringify(content ?? "");
        return { sessionId, events: [{ type: "shell", summary: text || "tool progress" }] };
      }
      return null;
    }

    if (type === "result") {
      const isError = record.is_error === true;
      const text = typeof record.result === "string" ? record.result : "";
      const errObj = record.error as { message?: string } | undefined;
      const errorText = isError ? errObj?.message ?? (typeof record.subtype === "string" ? record.subtype : "qwen-code error") : undefined;
      return {
        sessionId,
        finalText: !isError && text !== "" ? text : undefined,
        errorText,
        turnFinished: true,
        events: [
          {
            type: isError ? "error" : "status",
            summary: isError ? `result error: ${errorText}` : `result success (${String(record.num_turns ?? 1)} turns)`,
            data: { usage: record.usage, durationMs: record.duration_ms },
          },
        ],
      };
    }

    return { sessionId, events: [{ type: "status", summary: type || "event", data: record }] };
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

function sanitizeQwenStderr(raw: string): string {
  return raw
    .replace(/Warning:\s*running headless with --yolo[\s\S]*?silence this notice\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatToolCallSummary(name: string, input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    const target = rec.file_path ?? rec.path ?? rec.command ?? rec.pattern;
    if (typeof target === "string" && target.trim() !== "") return `${name}(${target.trim()})`;
  }
  return name;
}

function extractEditedFile(name: string, input: unknown): string | null {
  if (!EDIT_TOOL_NAMES.has(name.toLowerCase())) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const rec = input as Record<string, unknown>;
  const path = rec.file_path ?? rec.path ?? rec.target_file;
  return typeof path === "string" && path.trim() !== "" ? path.trim() : null;
}

function resolveBinary(command: string): string | null {
  const candidates = command === "qwen" ? ["qwen", "qwen-code"] : [command];
  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    try {
      const found = execFileSync("sh", ["-c", `command -v ${JSON.stringify(candidate)}`], { encoding: "utf8" }).trim();
      if (found) return found;
    } catch {
      // try next candidate
    }
  }
  return null;
}
