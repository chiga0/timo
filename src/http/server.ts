import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";

/** Standard error shape returned by every route. */
export interface HttpError {
  code: string;
  message: string;
  details?: unknown;
}

export interface RouteContext {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: unknown;
  /** Raw Accept header, used to negotiate JSON vs SSE on `/events` endpoints. */
  accept: string;
  /** True when the caller authenticated as the local CLI over the Unix socket. */
  trustedLocal: boolean;
}

export type RouteHandler = (context: RouteContext) => Promise<RouteResult> | RouteResult;

export interface RouteResult {
  status?: number;
  body?: unknown;
  /** Streams a response; the handler owns the socket lifecycle. */
  stream?: (res: ServerResponse, signal: AbortSignal) => Promise<void>;
}

export class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RouteError";
  }
}

export interface Route {
  method: string;
  /** `/api/tasks/:id/stop` style; `:name` captures one path segment. */
  path: string;
  handler: RouteHandler;
}

/**
 * Minimal router over `node:http`. Two listeners share it: the Unix socket for
 * the local CLI (implicitly trusted, 0600) and an optional loopback port for the
 * Web console, which must present a session token on every request.
 */
export class Router {
  private readonly routes: Route[] = [];
  /** Optional catch-all for client-side routing (static bundle fallback). */
  private fallbackHandler: RouteHandler | null = null;

  add(method: string, path: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), path, handler });
    return this;
  }

  /** Serves every unmatched GET, used by the SPA bundle for deep client routes. */
  fallback(handler: RouteHandler): this {
    this.fallbackHandler = handler;
    return this;
  }

  async dispatch(context: RouteContext): Promise<{ route: Route; params: Record<string, string> } | null> {
    for (const route of this.routes) {
      if (route.method !== context.method) continue;
      const params = matchPath(route.path, context.path);
      if (params) return { route, params };
    }
    // HEAD falls back to GET so health checks work without a body.
    if (context.method === "HEAD") {
      for (const route of this.routes) {
        if (route.method !== "GET") continue;
        const params = matchPath(route.path, context.path);
        if (params) return { route, params };
      }
    }
    if (this.fallbackHandler && (context.method === "GET" || context.method === "HEAD")) {
      return { route: { method: "GET", path: "*", handler: this.fallbackHandler }, params: {} };
    }
    return null;
  }
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index++) {
    const expected = patternParts[index]!;
    const actual = pathParts[index]!;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

export interface ListenerOptions {
  router: Router;
  /** Unix socket path, or `{host, port}` for a TCP listener. */
  target: { socketPath: string } | { host: string; port: number };
  /** Required for TCP listeners; absent means every request is trusted (Unix socket). */
  token?: string;
  maxBodyBytes?: number;
  onError?: (error: unknown) => void;
}

export interface RunningListener {
  /** Bound port for TCP listeners (needed when `port: 0` was requested). */
  port: number | null;
  close: () => Promise<void>;
}

/**
 * Starts one HTTP listener. The Unix socket is the trust boundary itself (mode
 * 0600), so it needs no token; the loopback listener always demands a bearer
 * token because any local process can reach a TCP port.
 */
export async function startListener(options: ListenerOptions): Promise<RunningListener> {
  // Live stream controllers, so closing the listener also tears down SSE streams
  // that are still open (a test or a browser tab that keeps them alive).
  const streams = new Set<AbortController>();
  const server = createServer((req, res) => {
    void handleRequest(options, req, res, streams);
  });
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;

  const isSocket = "socketPath" in options.target;
  if (isSocket) {
    const socketPath = (options.target as { socketPath: string }).socketPath;
    if (existsSync(socketPath)) unlinkSync(socketPath);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        try {
          chmodSync(socketPath, 0o600);
        } catch {
          // best effort on platforms without POSIX modes
        }
        resolve();
      });
    });
    return {
      port: null,
      close: async () => {
        await closeServer(server);
        for (const controller of streams) controller.abort();
        try {
          if (existsSync(socketPath)) unlinkSync(socketPath);
        } catch {
          // already gone
        }
      },
    };
  }

  const tcp = options.target as { host: string; port: number };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(tcp.port, tcp.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  return {
    port,
    close: async () => {
      await closeServer(server);
      for (const controller of streams) controller.abort();
    },
  };
}
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function handleRequest(
  options: ListenerOptions,
  req: IncomingMessage,
  res: ServerResponse,
  streams: Set<AbortController>,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  try {
    const trustedLocal = options.token === undefined;
    if (!trustedLocal && !authorize(options.token!, req, url.searchParams)) {
      res.writeHead(401, { "content-type": "application/json; charset=utf-8", "www-authenticate": "Bearer" });
      res.end(JSON.stringify({ error: { code: "unauthorized", message: "missing or invalid session token" } }));
      return;
    }

    const accept = typeof req.headers.accept === "string" ? req.headers.accept : "";
    const dispatched = await options.router.dispatch({
      method: req.method ?? "GET",
      path,
      query: url.searchParams,
      params: {},
      body: undefined,
      accept,
      trustedLocal,
    });
    if (!dispatched) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: "not_found", message: `no route for ${req.method} ${path}` } }));
      return;
    }

    let body: unknown;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await readJsonBody(req, options.maxBodyBytes ?? 1024 * 1024);
    }
    const result = await dispatched.route.handler({
      method: req.method ?? "GET",
      path,
      query: url.searchParams,
      params: dispatched.params,
      body,
      accept,
      trustedLocal,
    });

    if (result.stream) {
      const controller = new AbortController();
      // A client that disconnects must stop the stream, not leak it. `close` on
      // the response is the reliable signal on Node 24; `aborted` covers an
      // early client reset that happens before the response is writable.
      res.on("close", () => controller.abort());
      req.on("aborted", () => controller.abort());
      streams.add(controller);
      try {
        await result.stream(res, controller.signal);
      } finally {
        streams.delete(controller);
      }
      return;
    }
    const status = result.status ?? 200;
    const payload = result.body === undefined ? "" : JSON.stringify(result.body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(payload);
  } catch (error) {
    if (res.writableEnded) return;
    const mapped =
      error instanceof RouteError
        ? { status: error.status, body: { error: { code: error.code, message: error.message, details: error.details } } }
        : { status: 500, body: { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } } };
    options.onError?.(error);
    res.writeHead(mapped.status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(mapped.body));
  }
}

/**
 * Accepts the session token three ways, each for a different client shape:
 * a bearer header (CLI/curl), the `timo_session` cookie (browser pages), and a
 * `?token=` query parameter — EventSource cannot set headers, so a live stream
 * opened from the page has no other way to authenticate.
 */
export function authorize(token: string, req: IncomingMessage, query?: URLSearchParams): boolean {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    if (constantTimeEquals(header.slice(7).trim(), token)) return true;
  }
  const cookie = req.headers.cookie;
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === "timo_session" && constantTimeEquals(rest.join("="), token)) return true;
    }
  }
  const fromQuery = query?.get("token");
  if (typeof fromQuery === "string" && fromQuery !== "" && constantTimeEquals(fromQuery, token)) return true;
  return false;
}

function constantTimeEquals(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) throw new RouteError(413, "payload_too_large", `request body exceeds ${limit} bytes`);
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new RouteError(400, "invalid_input", "request body is not valid JSON");
  }
}

/** High-entropy session token for the loopback listener. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Explained 401 shared by tests and the client. */
export const UNAUTHORIZED_CODE = "unauthorized";

export type { Socket };
