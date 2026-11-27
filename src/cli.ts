#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { resolveHome } from "./home.js";
import { defaultConfig } from "./config.js";
import { serve } from "./service/serve.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_INVALID_INPUT = 2;
const EXIT_NOT_FOUND = 3;
const EXIT_CONFLICT = 4;

const USAGE = `用法：
  timo serve                          前台启动任务服务（Unix socket，可加 TIMO_HTTP_PORT 开 Web）
  timo create --request-id ID --log FILE [--request TEXT]
                                      提交一份 SSE 日志诊断
  timo create --request-id ID --repo PATH[:BASE[:NAME]]... --request TEXT [--executor ID] [--check CMD]... [--model MODEL] [--max-repair N]
                                      提交一个多仓代码交付任务（独立 worktree + 声明式验收）
  timo get TASK_ID                    查询任务
  timo list [--status STATUS] [--limit N]
                                      列出任务，最新在前
  timo amend TASK_ID --version N [--goal TEXT] [--must ITEM]... [--must-not ITEM]...
                                      追加新的约定版本；版本过期返回冲突
  timo steer TASK_ID --message TEXT   向正在运行的执行器注入实时纠偏指令
  timo handoff TASK_ID --executor ID [--reason TEXT]
                                      不可变换执行器（g1 -> g2），迁移未提交改动与预算
  timo stop TASK_ID [--reason TEXT]   停止任务并作废当前执行代次
  timo executors                      查看已探测就绪的执行器列表

退出码：0 成功，1 服务或其他错误，2 参数或日志输入无效，3 任务不存在，4 请求冲突。
成功时 JSON 只写 stdout；诊断写 stderr。`;

class UsageError extends Error {}

interface CliResponse {
  ok: boolean;
  statusCode: number;
  result?: unknown;
  error?: { code: string; message: string };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    const stream = command === undefined ? process.stderr : process.stdout;
    stream.write(`${USAGE}\n`);
    return command === undefined ? EXIT_INVALID_INPUT : EXIT_OK;
  }
  if (command === "serve") return runServe();
  if (command === "create") return runCreate(rest);
  if (command === "get") return runGet(rest);
  if (command === "list") return runList(rest);
  if (command === "amend") return runAmend(rest);
  if (command === "steer") return runSteer(rest);
  if (command === "handoff") return runHandoff(rest);
  if (command === "stop") return runStop(rest);
  if (command === "executors") return emit(await call("GET", "/api/executors"));
  process.stderr.write(`未知命令：${command}\n\n${USAGE}\n`);
  return EXIT_INVALID_INPUT;
}

function runServe(): number {
  void serve().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`timo serve 启动失败：${message}\n`);
    process.exit(EXIT_ERROR);
  });
  return -1;
}

/** Flags may repeat (`--must a --must b`), so values are accumulated. */
function parseFlags(args: string[], known: Set<string>, repeatable = new Set<string>()): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) throw new UsageError(`无法识别的参数：${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (!known.has(name)) throw new UsageError(`未知选项：--${name}`);
    const value = inline ?? args[++index];
    if (value === undefined) throw new UsageError(`选项 --${name} 缺少取值`);
    if (!repeatable.has(name)) flags.set(name, [value]);
    else flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return flags;
}

function first(flags: Map<string, string[]>, name: string): string | undefined {
  return flags.get(name)?.[0];
}

function fail(code: number, message: string): number {
  process.stderr.write(`timo: ${message}\n`);
  return code;
}

async function runCreate(args: string[]): Promise<number> {
  let flags: Map<string, string[]>;
  try {
    flags = parseFlags(
      args,
      new Set(["request-id", "log", "request", "repo", "executor", "model", "check", "max-repair"]),
      new Set(["repo", "check"]),
    );
    if (!first(flags, "request-id")) throw new UsageError("缺少 --request-id");
    const hasLog = Boolean(first(flags, "log"));
    const hasRepo = (flags.get("repo")?.length ?? 0) > 0;
    if (!hasLog && !hasRepo) throw new UsageError("缺少 --log 或 --repo");
  } catch (error) {
    return fail(EXIT_INVALID_INPUT, error instanceof Error ? error.message : String(error));
  }

  const repoSpecs = flags.get("repo") ?? [];
  if (repoSpecs.length > 0) {
    const requestText = first(flags, "request")?.trim() ?? "";
    if (!requestText) return fail(EXIT_INVALID_INPUT, "代码交付任务必须提供 --request TEXT");
    const repos = repoSpecs.map((spec) => {
      const [sourcePath, baseRef = "main", name] = spec.split(":");
      return { sourcePath: sourcePath!, baseRef, ...(name ? { name } : {}) };
    });
    const checks = flags.get("check") ?? ["npm run typecheck && npm test"];
    const maxRepairRaw = first(flags, "max-repair");
    const maxRepairRounds = maxRepairRaw !== undefined ? Number(maxRepairRaw) : 2;
    const response = await call("POST", "/api/tasks", {
      requestId: first(flags, "request-id"),
      kind: "repo_delivery",
      requestText,
      executorId: first(flags, "executor") ?? "qwen-code",
      ...(first(flags, "model") ? { model: first(flags, "model") } : {}),
      repos,
      maxRepairRounds: Number.isInteger(maxRepairRounds) && maxRepairRounds >= 0 ? maxRepairRounds : 2,
      verificationPlan: {
        version: "cli-check-v1",
        steps: checks.map((command, idx) => ({
          type: "command_check",
          name: `check-${idx + 1}`,
          command,
          ...(repos.length === 1 && repos[0]?.name ? { repo: repos[0].name } : {}),
          combo: repos.length > 1,
        })),
      },
    });
    return emit(response);
  }

  const logPath = first(flags, "log")!;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(logPath));
  } catch (error) {
    return fail(EXIT_INVALID_INPUT, `无法读取日志文件 ${logPath}：${error instanceof Error ? error.message : String(error)}`);
  }
  const response = await call("POST", "/api/tasks", {
    requestId: first(flags, "request-id"),
    log: Buffer.from(bytes).toString("base64"),
    requestText: first(flags, "request") ?? "",
    ...(first(flags, "executor") ? { executorId: first(flags, "executor") } : {}),
  });
  return emit(response);
}

async function runSteer(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof splitPositional>;
  try {
    parsed = splitPositional(args, new Set(["message"]));
  } catch (error) {
    return fail(EXIT_INVALID_INPUT, error instanceof Error ? error.message : String(error));
  }
  if (parsed.positional.length !== 1) return fail(EXIT_INVALID_INPUT, "timo steer 需要一个 TASK_ID");
  const message = first(parsed.flags, "message")?.trim();
  if (!message) return fail(EXIT_INVALID_INPUT, "缺少 --message TEXT");
  return emit(await call("POST", `/api/tasks/${encodeURIComponent(parsed.positional[0]!)}/steer`, { message }));
}

async function runHandoff(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof splitPositional>;
  try {
    parsed = splitPositional(args, new Set(["executor", "reason"]));
  } catch (error) {
    return fail(EXIT_INVALID_INPUT, error instanceof Error ? error.message : String(error));
  }
  if (parsed.positional.length !== 1) return fail(EXIT_INVALID_INPUT, "timo handoff 需要一个 TASK_ID");
  const executorId = first(parsed.flags, "executor")?.trim();
  if (!executorId) return fail(EXIT_INVALID_INPUT, "缺少 --executor ID");
  const reason = first(parsed.flags, "reason")?.trim();
  return emit(
    await call("POST", `/api/tasks/${encodeURIComponent(parsed.positional[0]!)}/handoff`, {
      executorId,
      ...(reason ? { reason } : {}),
    }),
  );
}

async function runGet(args: string[]): Promise<number> {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length !== 1) return fail(EXIT_INVALID_INPUT, "timo get 需要一个 TASK_ID");
  return emit(await call("GET", `/api/tasks/${encodeURIComponent(positional[0]!)}`));
}

async function runList(args: string[]): Promise<number> {
  let flags: Map<string, string[]>;
  try {
    flags = parseFlags(args, new Set(["status", "limit"]));
  } catch (error) {
    return fail(EXIT_INVALID_INPUT, error instanceof Error ? error.message : String(error));
  }
  const query = new URLSearchParams();
  const status = first(flags, "status");
  const limit = first(flags, "limit");
  if (status) query.set("status", status);
  if (limit) query.set("limit", limit);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const response = await call("GET", `/api/tasks${suffix}`);
  if (!response.ok) return emit(response);
  const tasks = (response.result as { tasks: unknown[] } | undefined)?.tasks ?? [];
  for (const task of tasks) process.stdout.write(`${JSON.stringify(task)}\n`);
  return EXIT_OK;
}

async function runAmend(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof splitPositional>;
  try {
    parsed = splitPositional(
      args,
      new Set(["version", "goal", "must", "must-not", "evidence", "request"]),
      new Set(["must", "must-not", "evidence"]),
    );
  } catch (error) {
    return fail(EXIT_INVALID_INPUT, error instanceof Error ? error.message : String(error));
  }
  if (parsed.positional.length !== 1) return fail(EXIT_INVALID_INPUT, "timo amend 需要一个 TASK_ID");
  const taskId = parsed.positional[0]!;
  const flags = parsed.flags;
  const version = first(flags, "version");
  if (!version) return fail(EXIT_INVALID_INPUT, "缺少 --version（当前约定版本号）");
  const expected = Number(version);
  if (!Number.isInteger(expected) || expected < 1) return fail(EXIT_INVALID_INPUT, "--version 必须是正整数");
  const body: Record<string, unknown> = { expectedBriefVersion: expected };
  const goal = first(flags, "goal");
  if (goal) body.goal = goal;
  if (flags.get("must")) body.must = flags.get("must");
  if (flags.get("must-not")) body.mustNot = flags.get("must-not");
  if (flags.get("evidence")) body.evidence = flags.get("evidence");
  const requestText = first(flags, "request");
  if (requestText) body.requestText = requestText;
  return emit(await call("POST", `/api/tasks/${encodeURIComponent(taskId)}/amend`, body));
}

async function runStop(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof splitPositional>;
  try {
    parsed = splitPositional(args, new Set(["reason"]));
  } catch (error) {
    return fail(EXIT_INVALID_INPUT, error instanceof Error ? error.message : String(error));
  }
  if (parsed.positional.length !== 1) return fail(EXIT_INVALID_INPUT, "timo stop 需要一个 TASK_ID");
  return emit(
    await call("POST", `/api/tasks/${encodeURIComponent(parsed.positional[0]!)}/stop`, {
      reason: first(parsed.flags, "reason") ?? "user_requested",
    }),
  );
}

/**
 * Splits `args` into positional values and flags. Flag values are consumed by
 * `parseFlags`, so a value like `99` in `--version 99` is never mistaken for a
 * positional argument.
 */
function splitPositional(args: string[], known: Set<string>, repeatable = new Set<string>()): { positional: string[]; flags: Map<string, string[]> } {
  const flagArgs: string[] = [];
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    flagArgs.push(arg);
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (inline === undefined && known.has(name)) {
      const value = args[++index];
      if (value === undefined) throw new UsageError(`选项 --${name} 缺少取值`);
      flagArgs.push(value);
    }
  }
  return { positional, flags: parseFlags(flagArgs, known, repeatable) };
}

/**
 * Talks to the service over the Unix socket using `node:http`. The task is
 * durable once the service answers, so the CLI returns only after a response.
 */
async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<CliResponse> {
  const home = resolveHome(process.env);
  const config = defaultConfig(process.env, home);
  return new Promise<CliResponse>((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const req = request(
      {
        socketPath: config.socketPath,
        path,
        method,
        headers: payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const statusCode = res.statusCode ?? 0;
          let parsed: unknown;
          try {
            parsed = text === "" ? undefined : JSON.parse(text);
          } catch {
            resolve({ ok: false, statusCode, error: { code: "internal", message: `服务返回了无法解析的内容：${text.slice(0, 200)}` } });
            return;
          }
          if (statusCode >= 200 && statusCode < 300) resolve({ ok: true, statusCode, result: parsed });
          else resolve({ ok: false, statusCode, error: (parsed as { error?: { code: string; message: string } })?.error });
        });
      },
    );
    req.on("error", (error: NodeJS.ErrnoException) => {
      const message =
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? `无法连接任务服务（${error.code}）。请先运行 timo serve。`
          : `无法连接任务服务：${error.message}`;
      resolve({ ok: false, statusCode: 0, error: { code: "service_unavailable", message } });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function emit(response: CliResponse): number {
  if (response.ok) {
    process.stdout.write(`${JSON.stringify(response.result ?? null)}\n`);
    return EXIT_OK;
  }
  const code = response.error?.code ?? "internal";
  const message = response.error?.message ?? "未知错误";
  switch (code) {
    case "not_found":
      return fail(EXIT_NOT_FOUND, message);
    case "request_conflict":
    case "version_conflict":
    case "task_terminated":
    case "invalid_state":
      return fail(EXIT_CONFLICT, message);
    case "invalid_input":
    case "unsupported":
      return fail(EXIT_INVALID_INPUT, message);
    default:
      return fail(EXIT_ERROR, message);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    if (code >= 0) process.exitCode = code;
  })
  .catch((error: unknown) => {
    fail(EXIT_ERROR, error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT_ERROR;
  });
