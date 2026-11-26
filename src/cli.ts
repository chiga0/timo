#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveHome } from "./home.js";
import { callService, ServiceUnavailableError, type WireResponse } from "./ipc.js";
import { defaultConfig } from "./config.js";
import { serve } from "./service/serve.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_INVALID_INPUT = 2;
const EXIT_NOT_FOUND = 3;
const EXIT_CONFLICT = 4;

const USAGE = `用法：
  timo serve                          前台启动任务服务
  timo create --request-id ID --log FILE [--request TEXT]
                                      提交一份 SSE 日志诊断
  timo get TASK_ID                    查询任务

退出码：0 成功，1 服务或其他错误，2 参数或日志输入无效，3 任务不存在，4 请求冲突。
成功时 JSON 只写 stdout；诊断写 stderr。`;

class UsageError extends Error {}

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

function parseFlags(args: string[], known: Set<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) throw new UsageError(`无法识别的参数：${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (!known.has(name)) throw new UsageError(`未知选项：--${name}`);
    const value = inline ?? args[++index];
    if (value === undefined) throw new UsageError(`选项 --${name} 缺少取值`);
    flags.set(name, value);
  }
  return flags;
}

async function runCreate(args: string[]): Promise<number> {
  let flags: Map<string, string>;
  try {
    flags = parseFlags(args, new Set(["request-id", "log", "request"]));
    if (!flags.get("request-id")) throw new UsageError("缺少 --request-id");
    if (!flags.get("log")) throw new UsageError("缺少 --log");
  } catch (error) {
    return fail(EXIT_INVALID_INPUT, error instanceof Error ? error.message : String(error));
  }
  const logPath = flags.get("log")!;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(logPath));
  } catch (error) {
    return fail(EXIT_INVALID_INPUT, `无法读取日志文件 ${logPath}：${error instanceof Error ? error.message : String(error)}`);
  }
  const response = await call("create", {
    requestId: flags.get("request-id")!,
    log: Buffer.from(bytes).toString("base64"),
    requestText: flags.get("request") ?? "",
  });
  return emit(response);
}

async function runGet(args: string[]): Promise<number> {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length !== 1) return fail(EXIT_INVALID_INPUT, "timo get 需要一个 TASK_ID");
  const response = await call("get", { taskId: positional[0] });
  return emit(response);
}

/**
 * Talks to the service over the Unix socket. The task is durable once the
 * service answers, so the CLI returns only after a response arrives.
 */
async function call(command: "create" | "get", params: Record<string, unknown>): Promise<WireResponse> {
  const home = resolveHome(process.env);
  const config = defaultConfig(process.env, home);
  try {
    return await callService(config.socketPath, { id: randomUUID(), command, params });
  } catch (error) {
    if (error instanceof ServiceUnavailableError) return { id: "", ok: false, error: { code: "service_unavailable", message: error.message } };
    throw error;
  }
}

function emit(response: WireResponse): number {
  if (response.ok) {
    process.stdout.write(`${JSON.stringify(response.result)}\n`);
    return EXIT_OK;
  }
  const code = response.error?.code ?? "internal";
  const message = response.error?.message ?? "未知错误";
  switch (code) {
    case "not_found":
      return fail(EXIT_NOT_FOUND, message);
    case "request_conflict":
      return fail(EXIT_CONFLICT, message);
    case "invalid_input":
    case "unsupported":
      return fail(EXIT_INVALID_INPUT, message);
    default:
      return fail(EXIT_ERROR, message);
  }
}

function fail(code: number, message: string): number {
  process.stderr.write(`timo: ${message}\n`);
  return code;
}

main(process.argv.slice(2))
  .then((code) => {
    if (code >= 0) process.exitCode = code;
  })
  .catch((error: unknown) => {
    fail(EXIT_ERROR, error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT_ERROR;
  });

