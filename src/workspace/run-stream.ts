import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
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
export class RunStreamStore {
  constructor(private readonly home: string) {}

  pathFor(taskId: string, runId: string): string {
    return join(this.home, "runs", sanitize(taskId), `${sanitize(runId)}.ndjson`);
  }

  append(event: RunStreamEvent): void {
    const path = this.pathFor(event.taskId, event.runId);
    mkdirSync(join(this.home, "runs", sanitize(event.taskId)), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
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
}

/**
 * Keeps a task/run id from escaping the runs directory. Dots are collapsed so a
 * crafted id like `../..` cannot produce a traversal segment.
 */
function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return cleaned === "" ? "_" : cleaned;
}
