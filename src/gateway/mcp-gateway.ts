import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { TaskService } from "../service/task-service.js";
import { AuthorizationEvaluator } from "../auth/evaluator.js";

/**
 * Local Capability MCP Gateway (Step 4.1).
 *
 * Exposes a Streamable HTTP MCP server on loopback (`127.0.0.1`) under
 * `/mcp/:taskId/:generation/:nonce` enforcing four gates on every request:
 * 1. Generation Fencing Token: revoked or stale generation returns HTTP 403 `GENERATION_REVOKED`.
 * 2. Tool Visibility Pruning: `tools/list` returns ONLY tools permitted by the
 *    task's current `GrantRevision` (or Tier 0 policy); direct `tools/call` on
 *    ungranted tools is also rejected.
 * 3. In-place grant elevation (`timo_request_grant`): Tier 1 auto-grants silently
 *    and immediately widens visible tools; Tier 2 parks in `waiting(needs_human_decision)`
 *    without failing the task.
 * 4. Credential isolation: business credentials live only inside the gateway
 *    process and are never passed to worker subprocesses.
 */

export interface GatewayCallContext {
  taskId: string;
  generation: number;
  nonce: string;
  service: TaskService;
  credentials: Record<string, string | undefined>;
}

export interface GatewayToolResult {
  isError?: boolean;
  data: unknown;
}

export interface GatewayToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Action required in GrantRevision (or Tier 0 policy). Absent means always visible (e.g. `timo_request_grant`). */
  requiredAction?: string;
  /** Optional environment scope for permission check. */
  requiredEnvironment?: string | null;
  handler: (args: Record<string, unknown>, ctx: GatewayCallContext) => Promise<GatewayToolResult>;
}

interface ActiveToken {
  taskId: string;
  generation: number;
  nonce: string;
  revoked: boolean;
}

export interface CapabilityMcpGatewayOptions {
  service: TaskService;
  host?: string;
  port?: number;
  /** Real platform credentials held strictly inside the gateway process. */
  credentials?: Record<string, string | undefined>;
  onError?: (error: unknown) => void;
}

const MCP_PATH_RE = /^\/mcp\/([^/]+)\/(\d+)\/([^/]+)$/;

export class CapabilityMcpGateway {
  private readonly tools = new Map<string, GatewayToolDefinition>();
  /** Keyed by `${taskId}:${generation}` -> active fencing token. */
  private readonly tokens = new Map<string, ActiveToken>();
  private readonly credentials: Record<string, string | undefined>;
  private server: HttpServer | null = null;
  private boundPort: number | null = null;
  private readonly host: string;

  constructor(private readonly options: CapabilityMcpGatewayOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.credentials = options.credentials ?? {};
    this.registerBuiltinRequestGrant();
  }

  /** Registers a controlled capability tool on the gateway. */
  registerTool(definition: GatewayToolDefinition): void {
    this.tools.set(definition.name, definition);
  }

  get port(): number | null {
    return this.boundPort;
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server && this.boundPort !== null) {
      return { host: this.host, port: this.boundPort };
    }
    const server = createServer((req, res) => {
      void this.handleHttp(req, res).catch((error) => {
        this.options.onError?.(error);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: { code: "internal", message: error instanceof Error ? error.message : String(error) } }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 0, this.host, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    this.server = server;
    this.boundPort = port;
    return { host: this.host, port };
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  /**
   * Issues a short-lived fencing token URL for `(taskId, generation)` and
   * revokes any older generations for that same task.
   */
  issueToken(taskId: string, generation: number): { nonce: string; url: string; path: string } {
    for (const [key, entry] of this.tokens.entries()) {
      if (entry.taskId === taskId && entry.generation < generation) {
        entry.revoked = true;
        this.tokens.set(key, entry);
      }
    }
    const nonce = randomBytes(24).toString("base64url");
    this.tokens.set(`${taskId}:${generation}`, { taskId, generation, nonce, revoked: false });
    const path = `/mcp/${encodeURIComponent(taskId)}/${generation}/${nonce}`;
    const port = this.boundPort ?? this.options.port ?? 0;
    return { nonce, path, url: `http://${this.host}:${port}${path}` };
  }

  /** Convenience method matching `TaskRunner`'s `mcpGateway.issueUrl` hook. */
  issueUrl(taskId: string, generation: number): string {
    return this.issueToken(taskId, generation).url;
  }

  /** Revokes the active fencing token(s) for `taskId` (optionally a single generation). */
  revoke(taskId: string, generation?: number): void {
    for (const [key, entry] of this.tokens.entries()) {
      if (entry.taskId !== taskId) continue;
      if (generation !== undefined && entry.generation !== generation) continue;
      entry.revoked = true;
      this.tokens.set(key, entry);
    }
  }

  /** Evaluates whether `tool` is currently visible/callable for `taskId`. */
  isToolAllowed(taskId: string, tool: GatewayToolDefinition): boolean {
    if (!tool.requiredAction) return true;
    const view = this.options.service.getTaskView(taskId);
    if (!view) return false;

    // 1. Check explicit grants in the latest GrantRevision.
    const nowMs = Date.now();
    const granted = view.grants.some((grant) => {
      if (grant.action !== tool.requiredAction) return false;
      if (grant.expiresAt && Date.parse(grant.expiresAt) <= nowMs) return false;
      if (tool.requiredEnvironment && grant.environment && grant.environment !== tool.requiredEnvironment) return false;
      return true;
    });
    if (granted) return true;

    // 2. Check StandingPolicy Tier 0 (default allow without prompt). Tier 1 and Tier 2
    //    are NOT implicitly visible until granted via GrantRevision.
    const evaluator = new AuthorizationEvaluator(this.options.service.standingPolicy);
    const decision = evaluator.classify({
      action: tool.requiredAction,
      environment: tool.requiredEnvironment ?? null,
    });
    return decision.kind === "allow";
  }

  /** Returns the pruned tool list visible to `taskId` right now. */
  visibleTools(taskId: string): GatewayToolDefinition[] {
    const out: GatewayToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      if (this.isToolAllowed(taskId, tool)) out.push(tool);
    }
    return out;
  }

  /** Validates `(taskId, generation, nonce)` against both memory fencing table and DB execution state. */
  validateFencing(taskId: string, generation: number, nonce: string): { ok: true } | { ok: false; code: "GENERATION_REVOKED"; message: string } {
    const entry = this.tokens.get(`${taskId}:${generation}`);
    if (!entry || entry.revoked || !safeEquals(entry.nonce, nonce)) {
      return { ok: false, code: "GENERATION_REVOKED", message: `fencing token for ${taskId} g${generation} is revoked or invalid` };
    }
    const view = this.options.service.getTaskView(taskId);
    if (!view || !this.options.service.taskExecutionReachable(taskId)) {
      return { ok: false, code: "GENERATION_REVOKED", message: `execution for task ${taskId} has been revoked` };
    }
    if (view.execution && view.execution.generation !== generation) {
      return {
        ok: false,
        code: "GENERATION_REVOKED",
        message: `generation g${generation} is stale; current generation is g${view.execution.generation}`,
      };
    }
    return { ok: true };
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${this.host}`);
    const match = MCP_PATH_RE.exec(url.pathname);
    if (!match) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "unknown gateway path" } }));
      return;
    }
    const taskId = decodeURIComponent(match[1]!);
    const generation = Number(match[2]!);
    const nonce = decodeURIComponent(match[3]!);

    const fencing = this.validateFencing(taskId, generation, nonce);
    if (!fencing.ok) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: fencing.code, message: fencing.message } }));
      return;
    }

    // Stateless per-request MCP server & transport: guarantees live GrantRevision
    // pruning and immediate fencing revocation on every JSON-RPC request.
    const mcp = this.createScopedMcpServer({ taskId, generation, nonce });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close().catch(() => undefined);
      void mcp.close().catch(() => undefined);
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  }

  private createScopedMcpServer(scope: { taskId: string; generation: number; nonce: string }): McpServer {
    const server = new McpServer(
      { name: "timo-capability-gateway", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const visible = this.visibleTools(scope.taskId);
      return {
        tools: visible.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as { type: "object"; properties?: Record<string, object>; required?: string[] },
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params;
      // Re-verify fencing immediately before tool execution.
      const check = this.validateFencing(scope.taskId, scope.generation, scope.nonce);
      if (!check.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ code: check.code, message: check.message }) }],
        };
      }
      const tool = this.tools.get(name);
      if (!tool) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ code: "TOOL_NOT_FOUND", message: `unknown tool ${name}` }) }],
        };
      }
      if (!this.isToolAllowed(scope.taskId, tool)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "PERMISSION_DENIED",
                tool: name,
                requiredAction: tool.requiredAction,
                message: `tool ${name} is not granted for task ${scope.taskId}`,
              }),
            },
          ],
        };
      }

      const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
      try {
        const result = await tool.handler(args, {
          taskId: scope.taskId,
          generation: scope.generation,
          nonce: scope.nonce,
          service: this.options.service,
          credentials: this.credentials,
        });
        return {
          isError: result.isError === true,
          content: [{ type: "text", text: JSON.stringify(result.data) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ code: "TOOL_ERROR", message: error instanceof Error ? error.message : String(error) }),
            },
          ],
        };
      }
    });

    return server;
  }

  private registerBuiltinRequestGrant(): void {
    this.registerTool({
      name: "timo_request_grant",
      description: "Request a permission grant for the current task. Tier 1 grants silently; Tier 2 pauses the task for human approval.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action identifier, e.g. open_pull_request, read_logs, read_prod_logs, deploy_prod" },
          environment: { type: "string", description: "Target environment: dev, staging, or prod" },
          resource: { type: "string", description: "Target resource or repository" },
        },
        required: ["action"],
      },
      handler: async (args, ctx) => {
        const action = typeof args.action === "string" ? args.action.trim() : "";
        if (action === "") {
          return { isError: true, data: { code: "INVALID_INPUT", message: "action is required" } };
        }
        const environment = typeof args.environment === "string" ? args.environment : null;
        const resource = typeof args.resource === "string" ? args.resource : null;
        const outcome = ctx.service.requestAuthorization(ctx.taskId, { action, environment, resource });
        return {
          isError: outcome.decision === "deny",
          data: {
            ...outcome,
            paused: outcome.decision === "needs_human",
            visibleTools: this.visibleTools(ctx.taskId).map((t) => t.name),
          },
        };
      },
    });
  }
}

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
