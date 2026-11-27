import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RunStreamEvent } from "../adapters/execution.js";

/**
 * Live run stream storage. Each run is an append-only NDJSON file at
 * `<home>/runs/<taskId>/<runId>.ndjson`.
 *
 * This file is deliberately separate from `task_events`: process telemetry must
 * never reach the main conversation, the inbox, or the business event ledger
 * (docs/architecture.md "写入通道物理隔离").
 */
export interface LatestTaskProgress {
  taskId: string;
  runId: string;
  type: RunStreamEvent["type"];
  summary: string;
  at: number;
}

export class RunStreamStore {
  private readonly listeners = new Map<string, Set<(event: RunStreamEvent) => void>>();
  private readonly globalListeners = new Set<(event: RunStreamEvent) => void>();
  private readonly latestByTask = new Map<string, LatestTaskProgress>();

  constructor(private readonly home: string) {}

  pathFor(taskId: string, runId: string): string {
    return join(this.home, "runs", sanitize(taskId), `${sanitize(runId)}.ndjson`);
  }

  append(event: RunStreamEvent): void {
    const path = this.pathFor(event.taskId, event.runId);
    mkdirSync(join(this.home, "runs", sanitize(event.taskId)), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    if (event.type !== "text_delta" && event.summary.trim() !== "") {
      this.latestByTask.set(event.taskId, {
        taskId: event.taskId,
        runId: event.runId,
        type: event.type,
        summary: event.summary,
        at: event.at,
      });
    }
    const key = streamKey(event.taskId, event.runId);
    const subs = this.listeners.get(key);
    if (subs) {
      for (const listener of [...subs]) {
        try {
          listener(event);
        } catch {
          // A broken subscriber must never interrupt stream persistence.
        }
      }
    }
    for (const listener of [...this.globalListeners]) {
      try {
        listener(event);
      } catch {
        // Ignore broken global subscriber.
      }
    }
  }

  /** Subscribes to every live run stream event across all tasks (for compact task card updates). */
  subscribeAll(listener: (event: RunStreamEvent) => void): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  /** Latest non-empty progress summary observed for a task. */
  latestProgress(taskId: string): LatestTaskProgress | undefined {
    return this.latestByTask.get(taskId);
  }

  /** Subscribes to live events appended for one `(taskId, runId)` stream. */
  subscribe(taskId: string, runId: string, listener: (event: RunStreamEvent) => void): () => void {
    const key = streamKey(taskId, runId);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(key);
    };
  }

  /** Reads a run back from disk, oldest first. */
  read(taskId: string, runId: string, afterSeq = 0): RunStreamEvent[] {
    const path = this.pathFor(taskId, runId);
    if (!existsSync(path)) return [];
    const events: RunStreamEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const event = JSON.parse(line) as RunStreamEvent;
        if (event.seq > afterSeq) events.push(event);
      } catch {
        // A torn last line after a crash is skipped, not fatal.
      }
    }
    return events;
  }

  /** Run ids recorded for a task, newest first. */
  listRuns(taskId: string): string[] {
    const dir = join(this.home, "runs", sanitize(taskId));
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".ndjson"))
      .map((name) => name.slice(0, -".ndjson".length))
      .sort()
      .reverse();
  }

  /** Removes all persisted run stream files for a deleted task. */
  removeTask(taskId: string): void {
    const dir = join(this.home, "runs", sanitize(taskId));
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Keeps a task/run id from escaping the runs directory. Dots are collapsed so a
 * crafted id like `../..` cannot produce a traversal segment.
 */
function streamKey(taskId: string, runId: string): string {
  return `${sanitize(taskId)}:${sanitize(runId)}`;
}

function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return cleaned === "" ? "_" : cleaned;
}
