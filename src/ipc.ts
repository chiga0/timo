import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { ServiceConfig } from "./config.js";

export interface WireRequest {
  id: string;
  command: "create" | "get" | "status";
  params: Record<string, unknown>;
}

export interface WireResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** Command-level failures carry a stable code; the CLI maps it to an exit code. */
export class CommandError extends Error {
  constructor(
    readonly code: "not_found" | "request_conflict" | "invalid_input" | "unsupported" | "internal",
    message: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export class ServiceUnavailableError extends Error {
  override readonly name = "ServiceUnavailableError";
}

interface LockContent {
  pid: number;
}

/**
 * Single-instance guard: an exclusive `timo.sock.lock` holding the pid of the
 * live service. A second `timo serve` reports a conflict instead of stealing
 * the socket.
 */
export function acquireServiceLock(socketPath: string): { release: () => void } {
  const lockPath = `${socketPath}.lock`;
  if (existsSync(lockPath)) {
    try {
      const content = JSON.parse(readFileSync(lockPath, "utf8")) as LockContent;
      if (typeof content.pid === "number" && isAlive(content.pid)) {
        throw new ServiceUnavailableError(`timo service already running (pid ${content.pid}) at ${socketPath}`);
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableError) throw error;
    }
    unlinkSync(lockPath);
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid } satisfies LockContent), { mode: 0o600 });
  chmodSync(lockPath, 0o600);
  return {
    release: () => {
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone
      }
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {
        // ignore
      }
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StartedServer {
  close: () => Promise<void>;
  config: ServiceConfig;
}

export async function startServiceServer(config: ServiceConfig, handler: (request: WireRequest) => Promise<WireResponse>): Promise<StartedServer> {
  const net = await import("node:net");
  ensureNoStaleSocket(config.socketPath);
  const lock = acquireServiceLock(config.socketPath);
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = "";
    let answered = false;
    const reply = (response: WireResponse) => {
      if (answered) return;
      answered = true;
      socket.end(`${JSON.stringify(response)}\n`);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let request: WireRequest;
      try {
        request = JSON.parse(line) as WireRequest;
      } catch {
        reply({ id: "", ok: false, error: { code: "invalid_input", message: "malformed request" } });
        return;
      }
      void handler(request)
        .then((response) => reply(response))
        .catch((error: unknown) => {
          reply({
            id: request.id,
            ok: false,
            error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
          });
        });
    });
    // A client that half-closes right after writing still gets its answer.
    socket.on("end", () => {
      if (!answered) reply({ id: "", ok: false, error: { code: "invalid_input", message: "empty request" } });
    });
    socket.on("error", () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      lock.release();
      reject(new ServiceUnavailableError(`cannot listen on ${config.socketPath}: ${error.message}`));
    });
    server.listen(config.socketPath, () => {
      try {
        chmodSync(config.socketPath, 0o600);
      } catch {
        // best effort
      }
      resolve();
    });
  });

  return {
    config,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      lock.release();
    },
  };
}

function ensureNoStaleSocket(socketPath: string): void {
  if (!existsSync(socketPath)) return;
  // A socket without a live lock owner is left over from a killed service.
  const lockPath = `${socketPath}.lock`;
  if (!existsSync(lockPath)) unlinkSync(socketPath);
}

export async function callService(socketPath: string, request: WireRequest, timeoutMs = 15_000): Promise<WireResponse> {
  const net = await import("node:net");
  if (!existsSync(socketPath)) throw new ServiceUnavailableError(`timo service is not running (no socket at ${socketPath})`);
  return new Promise<WireResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new ServiceUnavailableError(`timo service did not answer within ${timeoutMs} ms`)));
      socket.destroy();
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("end", () => {
      finish(() => {
        try {
          resolve(JSON.parse(buffer) as WireResponse);
        } catch {
          reject(new ServiceUnavailableError("timo service returned malformed output"));
        }
      });
    });
    socket.on("error", (error) => {
      finish(() => reject(new ServiceUnavailableError(`cannot reach timo service: ${error.message}`)));
    });
  });
}
