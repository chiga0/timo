import type { TaskEvent, EventType } from "./types.js";

export type EventListener = (event: TaskEvent) => void;

/**
 * In-process fan-out for committed business events. It is a *notification*
 * channel, never a source of truth: subscribers that need the full history read
 * `task_events` with `afterSeq`. Listeners are isolated so one throwing
 * subscriber cannot break the writer or the other subscribers.
 */
export class TypedEventBus {
  private readonly listeners = new Map<EventType | "*", Set<EventListener>>();
  private readonly publishLog: number[] = [];
  private closed = false;

  /** Subscribes to one event type, or `*` for all of them. Returns an unsubscribe fn. */
  on(type: EventType | "*", listener: EventListener): () => void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(type);
    };
  }

  /** Publishes an already-committed event. Never call this inside a transaction. */
  publish(event: TaskEvent, onError?: (error: unknown) => void): void {
    if (this.closed) return;
    this.publishLog.push(event.seq);
    for (const listener of this.listeners.get(event.type) ?? []) run(listener, event, onError);
    for (const listener of this.listeners.get("*") ?? []) run(listener, event, onError);
  }

  /** Sequence numbers broadcast so far, used by tests to prove no phantom publish. */
  get publishedSeqs(): readonly number[] {
    return this.publishLog;
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}

function run(listener: EventListener, event: TaskEvent, onError?: (error: unknown) => void): void {
  try {
    listener(event);
  } catch (error) {
    onError?.(error);
  }
}
