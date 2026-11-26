import type { Router } from "../http/server.js";
import { RouteError } from "../http/server.js";
import type { TaskService } from "../service/task-service.js";
import { TaskConflictError, TaskNotFoundError, InvalidInputError } from "../service/task-service.js";
import { ProposalConflictError } from "../auth/proposals.js";
import { RequestConflictError } from "../store/tasks.js";
import { CommandError } from "../ipc.js";
import type { EventLedger } from "../events/ledger.js";
import type { TypedEventBus } from "../events/bus.js";
import type { TaskEvent } from "../events/types.js";

export interface ApiDeps {
  service: TaskService;
  ledger: EventLedger;
  bus: TypedEventBus;
  /** Heartbeat interval for SSE streams, in ms. */
  heartbeatMs?: number;
  /** Human-readable service start time, for `/api/health`. */
  startedAt: string;
  t3Configured: boolean;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

/**
 * REST + SSE surface shared by the CLI (over the Unix socket) and the Web
 * console (over loopback with a session token). Both hit the same application
 * layer, so the CLI cannot drift from what the browser sees.
 */
export function registerApi(router: Router, deps: ApiDeps): void {
  const heartbeatMs = deps.heartbeatMs ?? 15_000;

  router.add("GET", "/api/health", () => ({
    body: {
      ok: true,
      startedAt: deps.startedAt,
      latestSeq: deps.ledger.latestSeq(),
      t3: deps.t3Configured ? "configured" : "unconfigured",
    },
  }));

  router.add("GET", "/api/tasks", (context) => {
    const limit = parsePositiveInt(context.query.get("limit"), 200);
    const status = context.query.get("status") ?? undefined;
    return { body: { tasks: deps.service.listTasks(limit, status) } };
  });

  router.add("POST", "/api/tasks", (context) => {
    const body = asRecord(context.body);
    const requestId = requireString(body.requestId, "requestId");
    const rawLog = body.log;
    if (typeof rawLog !== "string") throw new RouteError(400, "invalid_input", "log (base64) is required");
    const bytes = Uint8Array.from(Buffer.from(rawLog, "base64"));
    const created = withMappedErrors(() =>
      deps.service.createTask({
        requestId,
        log: bytes,
        requestText: typeof body.requestText === "string" ? body.requestText : undefined,
      }),
    );
    return { status: 201, body: { taskId: created.taskId, status: created.status, reused: created.reused } };
  });

  router.add("GET", "/api/tasks/:id", (context) => {
    const taskId = context.params.id!;
    return { body: withMappedErrors(() => deps.service.getTask(taskId)) };
  });

  router.add("GET", "/api/tasks/:id/events", (context) => {
    const taskId = context.params.id!;
    const afterSeq = parseNonNegativeInt(context.query.get("afterSeq"), 0);
    const wantsJson = context.query.get("format") === "json" || !context.accept.includes("text/event-stream");
    if (wantsJson) {
      const limit = parsePositiveInt(context.query.get("limit"), 500);
      return { body: { events: deps.ledger.forTask(taskId, afterSeq, limit) } };
    }
    return {
      stream: async (res, signal) => {
        await streamEvents(deps, res, signal, { afterSeq, heartbeatMs, filter: (event) => event.taskId === taskId });
      },
    };
  });

  router.add("GET", "/api/events", (context) => {
    return {
      stream: async (res, signal) => {
        const afterSeq = parseNonNegativeInt(context.query.get("afterSeq"), 0);
        await streamEvents(deps, res, signal, { afterSeq, heartbeatMs });
      },
    };
  });

  router.add("POST", "/api/tasks/:id/amend", (context) => {
    const taskId = context.params.id!;
    const body = asRecord(context.body);
    const expected = body.expectedBriefVersion;
    if (typeof expected !== "number" || !Number.isInteger(expected)) {
      throw new RouteError(400, "invalid_input", "expectedBriefVersion (integer) is required");
    }
    const result = withMappedErrors(() =>
      deps.service.amendTask(taskId, {
        expectedBriefVersion: expected,
        goal: optionalString(body.goal),
        must: optionalStringArray(body.must),
        mustNot: optionalStringArray(body.mustNot),
        evidence: optionalStringArray(body.evidence),
        requestText: optionalString(body.requestText),
      }),
    );
    return { body: { taskId, briefVersion: result.briefVersion } };
  });

  router.add("POST", "/api/tasks/:id/stop", (context) => {
    const taskId = context.params.id!;
    const body = asRecord(context.body);
    const result = withMappedErrors(() =>
      deps.service.stopTask(taskId, { reason: optionalString(body.reason) }),
    );
    // The final `stopped` transition follows once the interrupt is acknowledged.
    return { status: 202, body: { taskId, status: result.status } };
  });

  // ---- Step 2.1: standing policy, attention firewall, two-phase proposals ----

  router.add("GET", "/api/inbox", () => ({
    body: { items: deps.service.listInbox() },
  }));

  router.add("GET", "/api/policy", () => ({
    body: withMappedErrors(() => deps.service.policySnapshot()),
  }));

  router.add("POST", "/api/tasks/:id/authorize", (context) => {
    const taskId = context.params.id!;
    const body = asRecord(context.body);
    const action = requireString(body.action, "action");
    const result = withMappedErrors(() =>
      deps.service.requestAuthorization(taskId, {
        action,
        environment: optionalString(body.environment) ?? null,
        resource: optionalString(body.resource) ?? null,
      }),
    );
    return { body: { taskId, ...result } };
  });

  router.add("POST", "/api/tasks/:id/authorize/resolve", (context) => {
    const taskId = context.params.id!;
    const body = asRecord(context.body);
    const action = requireString(body.action, "action");
    const approved = body.approved;
    if (typeof approved !== "boolean") throw new RouteError(400, "invalid_input", "approved (boolean) is required");
    const result = withMappedErrors(() =>
      deps.service.resolveAuthorization(taskId, { action, approved, reason: optionalString(body.reason) }),
    );
    return { body: { taskId, ...result } };
  });

  router.add("GET", "/api/tasks/:id/proposals", (context) => {
    const taskId = context.params.id!;
    return { body: { proposals: withMappedErrors(() => deps.service.listProposals(taskId)) } };
  });

  router.add("POST", "/api/tasks/:id/proposals", (context) => {
    const taskId = context.params.id!;
    const body = asRecord(context.body);
    const kind = body.kind === "grant" ? "grant" : "brief";
    let diff = Array.isArray(body.diff)
      ? body.diff.filter(
          (item): item is { field: string; before: string; after: string } =>
            !!item && typeof item === "object" && typeof (item as { field?: unknown }).field === "string",
        )
      : [];
    let briefPayload = body.brief;
    // Shorthand: allow callers (like the web UI) to propose a new `goal` and
    // auto-compute the full brief + before/after diff against the current brief.
    if (kind === "brief" && !briefPayload && typeof body.goal === "string" && body.goal.trim() !== "") {
      const current = withMappedErrors(() => deps.service.getBrief(taskId));
      const nextGoal = body.goal.trim();
      briefPayload = { ...current, goal: nextGoal };
      if (diff.length === 0) diff = [{ field: "goal", before: current.goal, after: nextGoal }];
    }
    const change = {
      kind,
      diff,
      ...(kind === "brief" && briefPayload ? { brief: briefPayload } : {}),
      ...(kind === "grant" && Array.isArray(body.grants) ? { grants: body.grants } : {}),
    } as Parameters<TaskService["proposeChange"]>[1]["change"];
    const proposal = withMappedErrors(() => deps.service.proposeChange(taskId, { change, reason: optionalString(body.reason) ?? "proposed change" }));
    // A proposal never mutates the task: it only surfaces a diff card.
    return { status: 201, body: proposal };
  });

  router.add("POST", "/api/proposals/:pid/confirm", (context) => {
    return { body: withMappedErrors(() => deps.service.confirmProposal(context.params.pid!)) };
  });

  router.add("POST", "/api/proposals/:pid/cancel", (context) => {
    return { body: withMappedErrors(() => deps.service.cancelProposal(context.params.pid!)) };
  });
}

interface StreamOptions {
  afterSeq: number;
  heartbeatMs: number;
  filter?: (event: TaskEvent) => boolean;
}

/**
 * Replays `seq > afterSeq` first, then forwards live bus events. The client's
 * `lastSeq` therefore never skips an event: the replay and the subscription are
 * installed before the first read, and duplicates are dropped by sequence.
 */
async function streamEvents(
  deps: ApiDeps,
  res: import("node:http").ServerResponse,
  signal: AbortSignal,
  options: StreamOptions,
): Promise<void> {
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders?.();
  let last = options.afterSeq;

  const write = (event: TaskEvent) => {
    if (event.seq <= last) return;
    if (options.filter && !options.filter(event)) {
      last = event.seq;
      return;
    }
    last = event.seq;
    res.write(`id: ${event.seq}\nevent: task_event\ndata: ${JSON.stringify(event)}\n\n`);
  };

  // Subscribe first so an event committed during replay is not lost; the
  // sequence guard makes the overlap harmless.
  const pending: TaskEvent[] = [];
  let replaying = true;
  const unsubscribe = deps.bus.on("*", (event) => {
    if (replaying) pending.push(event);
    else write(event);
  });

  try {
    // Page through history so a backlog larger than one batch is never truncated
    // (the ledger read has a hard per-call limit).
    const batchSize = 500;
    let cursor = options.afterSeq;
    for (;;) {
      const batch = deps.ledger.afterSeq(cursor, batchSize);
      for (const event of batch) write(event);
      if (batch.length < batchSize) break;
      cursor = batch[batch.length - 1]!.seq;
    }
    replaying = false;
    for (const event of pending) write(event);
    pending.length = 0;

    const heartbeat = setInterval(() => {
      if (signal.aborted) return;
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, options.heartbeatMs);
    heartbeat.unref?.();

    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      res.on("close", () => resolve());
    });
    clearInterval(heartbeat);
  } finally {
    replaying = false;
    unsubscribe();
    if (!res.writableEnded) res.end();
  }
}

/** Maps application errors to HTTP status codes and stable error codes. */
export function withMappedErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw toRouteError(error);
  }
}

export function toRouteError(error: unknown): RouteError {
  if (error instanceof RouteError) return error;
  if (error instanceof TaskNotFoundError) return new RouteError(404, "not_found", error.message);
  if (error instanceof TaskConflictError) return new RouteError(409, error.code, error.message, error.details);
  if (error instanceof ProposalConflictError) return new RouteError(409, error.code, error.message);
  if (error instanceof RequestConflictError) return new RouteError(409, "request_conflict", error.message);
  if (error instanceof InvalidInputError) return new RouteError(400, "invalid_input", error.message);
  if (error instanceof CommandError) {
    const status = error.code === "not_found" ? 404 : error.code === "request_conflict" ? 409 : error.code === "unsupported" ? 405 : 400;
    return new RouteError(status, error.code, error.message);
  }
  return new RouteError(500, "internal", error instanceof Error ? error.message : String(error));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new RouteError(400, "invalid_input", `${field} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseNonNegativeInt(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}
