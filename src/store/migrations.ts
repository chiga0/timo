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
  {
    // Stopping a task must revoke its execution generation so late callbacks and
    // in-flight runs cannot keep writing results for a task the user ended.
    id: "0004-execution-revocation",
    sql: `
      ALTER TABLE executions ADD COLUMN revoked_at TEXT;
      CREATE INDEX executions_task_gen ON executions (task_id, generation);
    `,
  },
  {
    // Step 2.1: attention-firewall inbox and two-phase change proposals.
    // `inbox_items` is keyed by (task_id, decision_key) so repeated updates for
    // the same decision replace the card instead of appending another one.
    // `proposals` records a pending change; the task is only touched on confirm.
    id: "0005-policy-inbox-proposals",
    sql: `
      CREATE TABLE inbox_items (
        item_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        decision_key TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        options_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (task_id, decision_key)
      );
      CREATE INDEX inbox_items_updated ON inbox_items (updated_at);

      CREATE TABLE proposals (
        proposal_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        status TEXT NOT NULL,
        change_json TEXT NOT NULL,
        expected_brief_version INTEGER NOT NULL,
        expected_grant_version INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX proposals_task ON proposals (task_id, status);

      CREATE TABLE authorization_audit (
        audit_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        action TEXT NOT NULL,
        environment TEXT,
        resource TEXT,
        tier INTEGER NOT NULL,
        approved_by TEXT NOT NULL,
        grant_version INTEGER,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX authorization_audit_task ON authorization_audit (task_id, created_at);
    `,
  },
  {
    // Store the structured action on inbox decision cards so UI approval never
    // guesses the action name by parsing human summary text.
    id: "0006-inbox-action",
    sql: `
      ALTER TABLE inbox_items ADD COLUMN action TEXT;
    `,
  },
  {
    // Step 3.3 & Step 4.2: decouple tasks from hardcoded sse-v1, track multi-repo
    // checkouts, declarative verification plans, stale verification invalidation,
    // and idempotent external operations (MR/CI) with reconciliation timestamps.
    id: "0007-task-pipeline",
    sql: `
      ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'sse_log';
      ALTER TABLE tasks ADD COLUMN executor_id TEXT;
      ALTER TABLE tasks ADD COLUMN repos_json TEXT;
      ALTER TABLE tasks ADD COLUMN verification_plan_json TEXT;
      ALTER TABLE tasks ADD COLUMN max_repair_rounds INTEGER NOT NULL DEFAULT 2;

      ALTER TABLE verifications ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE verifications ADD COLUMN candidate_digest TEXT;

      ALTER TABLE operations ADD COLUMN operation_key TEXT;
      ALTER TABLE operations ADD COLUMN reconciled_at TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS operations_key_uniq ON operations (operation_key) WHERE operation_key IS NOT NULL;
    `,
  },
  {
    // Task management: allow user-defined title overrides and soft-archiving
    // tasks out of the default active list.
    id: "0008-task-management",
    sql: `
      ALTER TABLE tasks ADD COLUMN title_override TEXT;
      ALTER TABLE tasks ADD COLUMN archived_at TEXT;
      CREATE INDEX IF NOT EXISTS tasks_archived_idx ON tasks (archived_at, created_at DESC);
    `,
  },
  {
    // Main Chat persistence: global user <-> Timo conversation decoupled from
    // background tasks, plus cleanup of non-actionable completed inbox items.
    id: "0009-main-chat",
    sql: `
      CREATE TABLE chat_messages (
        message_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        task_id TEXT,
        executor_id TEXT,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'done',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_messages_created ON chat_messages (created_at);
      DELETE FROM inbox_items WHERE decision_key = 'delivery_verified';
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
