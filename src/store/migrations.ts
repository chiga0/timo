import { DatabaseSync } from "node:sqlite";
import type { Database } from "./database.js";

/** Each migration is applied once, in order, recorded in `schema_migrations`. */
const MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  {
    id: "0001-init",
    sql: `
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        waiting_reason TEXT,
        input_digest TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        thread_id TEXT,
        run_id TEXT,
        result_json TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE brief_revisions (
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        version INTEGER NOT NULL,
        request_text TEXT NOT NULL,
        requirements_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, version)
      );

      CREATE TABLE authorization_snapshots (
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        version INTEGER NOT NULL,
        grants_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, version)
      );

      CREATE TABLE executions (
        execution_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        generation INTEGER NOT NULL,
        environment TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (task_id, generation)
      );

      CREATE TABLE run_references (
        run_reference_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        execution_id TEXT NOT NULL REFERENCES executions(execution_id),
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        provider_instance_id TEXT,
        run_status TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        UNIQUE (thread_id, run_id)
      );

      CREATE TABLE candidates (
        candidate_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL,
        form TEXT NOT NULL,
        body_json TEXT NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE verifications (
        verification_id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id),
        brief_version INTEGER NOT NULL,
        verifier_version TEXT NOT NULL,
        result TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        environment TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE operations (
        operation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        client_request_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        receipt_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (task_id, kind)
      );

      CREATE TABLE attempts (
        attempt_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES operations(operation_id),
        error_kind TEXT,
        receipt_json TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE evidence (
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        name TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, name)
      );

      CREATE TABLE notifications (
        notification_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        kind TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        UNIQUE (task_id, kind)
      );
    `,
  },
  {
    // A task may legitimately enter the same waiting kind more than once (e.g.
    // auth fails twice). The UNIQUE (task_id, kind) from 0001 silently dropped
    // the second notification. The rule becomes "at most one *undelivered*
    // notification per (task_id, kind, dedupe_key)" via a partial unique index,
    // so delivered history never blocks a new entry.
    id: "0002-notification-dedupe",
    sql: `
      CREATE TABLE notifications_v2 (
        notification_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        kind TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        dedupe_key TEXT NOT NULL
      );

      INSERT INTO notifications_v2 (notification_id, task_id, kind, body_json, created_at, delivered_at, dedupe_key)
        SELECT notification_id, task_id, kind, body_json, created_at, delivered_at, kind
        FROM notifications;

      DROP TABLE notifications;
      ALTER TABLE notifications_v2 RENAME TO notifications;

      CREATE UNIQUE INDEX notifications_undelivered_uniq
        ON notifications (task_id, kind, dedupe_key)
        WHERE delivered_at IS NULL;
      CREATE INDEX notifications_task_idx ON notifications (task_id, created_at);
    `,
  },
  {
    // Append-only business fact stream plus the durable job queue. `task_events`
    // is the source of truth a reader replays with `afterSeq`; `outbox_jobs`
    // carries dispatch, reconciliation and (later) 0-Token polling so that a
    // crash or a sleeping laptop resumes from the database, not from memory.
    id: "0003-event-ledger",
    sql: `
      CREATE TABLE task_events (
        seq INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (task_id, idempotency_key)
      );
      CREATE INDEX task_events_task_seq ON task_events (task_id, seq);
      CREATE INDEX task_events_type_seq ON task_events (type, seq);

      CREATE TABLE outbox_jobs (
        job_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        run_after TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        lease_until TEXT,
        lease_owner TEXT,
        last_error TEXT,
        payload_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (task_id, kind, dedupe_key)
      );
      CREATE INDEX outbox_jobs_claim ON outbox_jobs (status, run_after);
      CREATE INDEX outbox_jobs_task ON outbox_jobs (task_id, kind);
    `,
  },
];

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies every pending migration inside one transaction with foreign keys on.
 * The database runs in WAL with short transactions so a crash leaves a
 * consistent set of tables.
 */
export function migrate(db: Database): MigrationResult {
  const raw: DatabaseSync = db.raw;
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const known = new Set(
    raw.prepare("SELECT id FROM schema_migrations").all().map((row) => String((row as { id: unknown }).id)),
  );
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const migration of MIGRATIONS) {
    if (known.has(migration.id)) {
      skipped.push(migration.id);
      continue;
    }
    raw.exec("BEGIN IMMEDIATE");
    try {
      raw.exec(migration.sql);
      raw.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, new Date().toISOString());
      raw.exec("COMMIT");
    } catch (error) {
      raw.exec("ROLLBACK");
      throw error;
    }
    applied.push(migration.id);
  }
  return { applied, skipped };
}
