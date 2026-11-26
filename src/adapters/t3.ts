import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Error classes the business layer must keep separate. */
export type T3ErrorKind = "auth" | "unsupported" | "tool_error" | "timeout" | "transient" | "protocol";

export class T3Error extends Error {
  constructor(
    readonly kind: T3ErrorKind,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "T3Error";
  }

  /** Only these kinds justify an automatic retry of the same request id. */
  get retryable(): boolean {
    return this.kind === "timeout" || this.kind === "transient";
  }

  get blocksDispatch(): boolean {
    return this.kind === "auth" || this.kind === "unsupported";
  }
}

/** Result of one tool call: structured payload or an explicit unknown effect. */
export type CallOutcome<T> = { ok: true; value: T } | { ok: false; error: T3Error };

/**
 * The narrow surface the task service depends on. The real implementation
 * speaks MCP over Streamable HTTP; tests inject a replacement transport.
 */
export interface T3Client {
  probe(): Promise<ProbeResult>;
  prepareThread(input: { title: string; projectId: string | null }): Promise<{ threadId: string }>;
  launch(input: {
    title: string;
    prompt: string;
    outputSchema: unknown;
    modelSelection: { instanceId: string; model: string };
    clientRequestId: string;
  }): Promise<{ threadId: string; runId: string | null; status: string | null }>;
  send(input: { threadId: string; prompt: string; outputSchema: unknown; clientRequestId: string }): Promise<{ runId: string; messageId: string; status: string }>;
  wait(input: { threadId: string; runId: string; timeoutMs: number }): Promise<{ status: string; timedOut: boolean; output?: unknown }>;
  read(input: { threadId: string; runId: string }): Promise<ThreadReading>;
  stop(input: { threadId: string; runId: string | null }): Promise<{ status: string }>;
  close(): Promise<void>;
}

export interface CapabilityFeatures {
  threadManagement?: boolean;
  incrementalThreadRead?: boolean;
  cancellation?: boolean;
}

export interface ProbeResult {
  environmentId: string | null;
  providers: string[];
  features: CapabilityFeatures;
}

export interface ThreadReading {
  threadStatus: string;
  runStatus: string | null;
  assistantText: string | undefined;
  items: Array<{ type: string; runId: string | null; status: string; text: string | null; position: number }>;
}

/** Creates a client bound to one OAuth token. A new token means a new scope. */
/**
 * Short-lived MCP connections are created per use, so the factory is async:
 * callers `await` it and failures surface as a rejected promise the runner
 * classifies as transient.
 */
export type T3ClientFactory = (config: T3Config) => Promise<T3Client>;

export interface T3Config {
  url: string;
  token: string;
  projectId: string;
  providerId: string;
  model: string;
}

/**
 * Client built on the official MCP SDK. It sends the externally issued bearer
 * token, restricts itself to the tools it needs and never falls back to another
 * transport or identity.
 */
export class McpT3Client implements T3Client {
  private constructor(
    private readonly client: Client,
    private readonly config: T3Config,
  ) {}

  static async connect(config: T3Config): Promise<McpT3Client> {
    const url = new URL(config.url);
    const token = config.token;
    // The token travels only in a header on each request; it never appears in a URL or file.
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        return response;
      },
    });
    const client = new Client({ name: "timo", version: "0.1.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
    } catch (error) {
      throw classify(error, "connect");
    }
    return new McpT3Client(client, config);
  }

  async probe(): Promise<{ environmentId: string | null; providers: string[]; features: CapabilityFeatures }> {
    const payload = await this.call<{ providers?: Array<{ providerInstanceId: string }>; features?: CapabilityFeatures }>("orchestrator_capabilities", {});
    return {
      environmentId: null,
      providers: (payload.providers ?? []).map((provider) => provider.providerInstanceId),
      features: payload.features ?? {},
    };
  }

  async prepareThread(input: { title: string; projectId: string | null }): Promise<{ threadId: string }> {
    const args: Record<string, unknown> = {
      title: input.title,
      modelSelection: { instanceId: this.config.providerId, model: this.config.model },
    };
    if (input.projectId) args.projectId = input.projectId;
    const payload = await this.call<{ threadId: string }>("t3_thread_launch", args);
    if (typeof payload.threadId !== "string" || payload.threadId === "") throw new T3Error("protocol", "t3_thread_launch returned no threadId");
    return { threadId: payload.threadId };
  }

  async launch(input: { title: string; prompt: string; outputSchema: unknown; modelSelection: { instanceId: string; model: string }; clientRequestId: string }): Promise<{ threadId: string; runId: string | null; status: string | null }> {
    const payload = await this.call<{ threadId: string; runId: string | null; status: string | null }>("t3_thread_launch", {
      projectId: this.config.projectId,
      title: input.title,
      message: input.prompt,
      outputSchema: input.outputSchema,
      modelSelection: input.modelSelection,
      clientRequestId: input.clientRequestId,
    });
    if (typeof payload.threadId !== "string" || payload.threadId === "") throw new T3Error("protocol", "t3_thread_launch returned no threadId");
    return { threadId: payload.threadId, runId: payload.runId ?? null, status: payload.status ?? null };
  }

  async send(input: { threadId: string; prompt: string; outputSchema: unknown; clientRequestId: string }): Promise<{ runId: string; messageId: string; status: string }> {
    const payload = await this.call<{ runId: string; messageId: string; status: string }>("t3_thread_send", {
      threadId: input.threadId,
      message: input.prompt,
      mode: "queue",
      outputSchema: input.outputSchema,
      clientRequestId: input.clientRequestId,
    });
    if (typeof payload.runId !== "string" || payload.runId === "") throw new T3Error("protocol", "t3_thread_send returned no runId");
    return { runId: payload.runId, messageId: String(payload.messageId ?? ""), status: String(payload.status ?? "") };
  }

  async wait(input: { threadId: string; runId: string; timeoutMs: number }): Promise<{ status: string; timedOut: boolean; output?: unknown }> {
    const payload = await this.call<{ status: string; timedOut: boolean; output?: unknown }>("t3_thread_wait", {
      threadId: input.threadId,
      runId: input.runId,
      timeoutMs: input.timeoutMs,
      untilOutput: true,
    });
    return { status: String(payload.status), timedOut: payload.timedOut === true, output: payload.output };
  }

  async read(input: { threadId: string; runId: string }): Promise<ThreadReading> {
    const payload = await this.call<{
      thread: { status: string; latestRunId: string | null };
      runs?: Array<{ runId: string; status: string }>;
      items: Array<{ position: number; runId: string | null; status: string; type: string; text: string | null }>;
    }>("t3_thread_read", { threadId: input.threadId, view: "messages", afterPosition: -1, limit: 100 });
    const run = (payload.runs ?? []).find((candidate) => candidate.runId === input.runId);
    const items = payload.items.filter((item) => item.runId === input.runId);
    const assistantText = items
      .filter((item) => item.type === "assistant_message" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");
    return {
      threadStatus: payload.thread.status,
      runStatus: run?.status ?? null,
      assistantText: assistantText.length > 0 ? assistantText : undefined,
      items: items.map((item) => ({ position: item.position, runId: item.runId, status: item.status, type: item.type, text: item.text })),
    };
  }

  async stop(input: { threadId: string; runId: string | null }): Promise<{ status: string }> {
    const args: Record<string, unknown> = { threadId: input.threadId };
    if (input.runId) args.runId = input.runId;
    const payload = await this.call<{ status: string }>("t3_thread_interrupt", args);
    return { status: String(payload.status) };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }

  private async call<T>(name: string, args: Record<string, unknown>, options: { expectSchemaField?: boolean } = {}): Promise<T> {
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await this.client.callTool({ name, arguments: args });
    } catch (error) {
      throw classify(error, name);
    }
    const record = result as { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }> };
    if (record.isError) {
      const text = (record.content ?? []).map((item) => item.text ?? "").join("\n").trim();
      throw new T3Error("tool_error", `${name} was rejected: ${text || "no message"}`);
    }
    let payload: unknown = record.structuredContent;
    if (payload === undefined) {
      const text = (record.content ?? []).find((item) => item.type === "text")?.text;
      if (text === undefined) throw new T3Error("protocol", `${name} returned no structured content`);
      try {
        payload = JSON.parse(text);
      } catch {
        throw new T3Error("protocol", `${name} returned non-JSON content`);
      }
    }
    if (typeof payload !== "object" || payload === null) throw new T3Error("protocol", `${name} returned a non-object payload`);
    if (options.expectSchemaField) {
      // Older servers ignore `outputSchema`; we do not pretend structured output was requested.
      return payload as T;
    }
    return payload as T;
  }
}

function classify(error: unknown, where: string): T3Error {
  if (error instanceof T3Error) return error;
  if (error instanceof StreamableHTTPError) {
    const code = Number(error.code);
    if (code === 401 || code === 403) return new T3Error("auth", `${where}: HTTP ${code}`, { code });
    if (code === 404 || code === 405) return new T3Error("unsupported", `${where}: HTTP ${code}`, { code });
    return new T3Error("transient", `${where}: HTTP ${code}`, { code });
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "AbortError" || /timed? ?out/i.test(message)) return new T3Error("timeout", `${where}: ${message}`);
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|socket hang up|network/i.test(message)) return new T3Error("transient", `${where}: ${message}`);
  return new T3Error("protocol", `${where}: ${message}`);
}

/** The dispatch prompt carries only the frozen log and the exact contract. */
export function buildPrompt(input: { taskId: string; digest: string; logText: string }): string {
  return [
    "你是 Timo 的执行者。只做这一件事：分析下面这段合成的 SSE 日志，提交结构化候选。",
    "约定：",
    "- 每条非空行为 `<RFC 3339 时间戳> <连接ID> <事件名>`，事件名为 CONNECT、DISCONNECT、RECONNECT、HEARTBEAT。",
    "- 空行保留行号，行号从 1 开始。",
    "- 同一连接的一条 RECONNECT 匹配它前面最早仍开放的 DISCONNECT；未被匹配的 DISCONNECT 的 reconnectLine 为 null。",
    "- 事故按 disconnectLine 升序，列出每次断连。",
    "- verdict 取 disconnected（存在断连）、no_disconnect（完整且无断连）或 unknown（日志为空或格式不完整）。",
    "- 全部为查证后的结论：不要编造行号，不要修改输入。禁止修改外部系统、创建文件或发起提交。",
    `- 候选中的 inputDigest 必须原样填写：${input.digest}`,
    `任务：${input.taskId}`,
    "日志开始（不含本行）>>>",
    input.logText,
    "<<< 日志结束",
    "只返回符合 outputSchema 的 JSON 候选。",
  ].join("\n");
}

export function readT3ConfigFromEnv(env: NodeJS.ProcessEnv): T3Config | null {
  const url = env.TIMO_T3_URL?.trim();
  const token = env.TIMO_T3_TOKEN?.trim();
  const projectId = env.TIMO_T3_PROJECT_ID?.trim();
  const providerId = env.TIMO_T3_PROVIDER_ID?.trim();
  const model = env.TIMO_T3_MODEL?.trim();
  if (!url || !token || !projectId || !providerId || !model) return null;
  return { url, token, projectId, providerId, model };
}

/** Reads the token from a file so it never lands on a command line. */
export function readTokenFile(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/** Real factory: one MCP connection per call site. */
export async function createMcpT3Client(config: T3Config): Promise<T3Client> {
  return McpT3Client.connect(config);
}
