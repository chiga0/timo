import { DatabaseSync } from "node:sqlite";

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Statement {
  run(...params: SqlValue[]): { changes: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

/**
 * Thin wrapper over node:sqlite. All synchronous calls; the service keeps
 * transactions short and avoids holding one across a network call.
 */
export class Database {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(readonly path: string) {
    this.raw = new DatabaseSync(path);
  }

  prepare(sql: string): Statement {
    const statement = this.raw.prepare(sql);
    return {
      run: (...params: SqlValue[]) => statement.run(...params) as { changes: number | bigint },
      get: (...params: SqlValue[]) => statement.get(...params),
      all: (...params: SqlValue[]) => statement.all(...params),
    };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Runs `fn` in an immediate transaction; nested calls join the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export function recordOf<T>(row: unknown): T | undefined {
  return row === undefined || row === null ? undefined : (row as T);
}
