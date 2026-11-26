import { newId, toIso } from "../util.js";
import type { Database } from "../store/database.js";
import type { BriefRequirements, Grant } from "../store/tasks.js";
import type { DecisionKey } from "./inbox.js";

/**
 * A proposed change that must not take effect until the user confirms it.
 *
 * Two-phase: `propose` records the intent and returns a diff card; only
 * `confirm` writes the change into the task. A rejected or abandoned proposal
 * therefore never touches the current `BriefRevision` or `GrantRevision`.
 */
export interface ProposalChange {
  kind: "brief" | "grant";
  /** For `brief`: the full replacement requirements. */
  brief?: BriefRequirements;
  /** For `grant`: grants to add to the authorization snapshot. */
  grants?: Grant[];
  /** Human-readable before/after lines rendered into the diff card. */
  diff: Array<{ field: string; before: string; after: string }>;
}

export type ProposalStatus = "pending" | "confirmed" | "cancelled" | "expired";

export interface Proposal {
  proposalId: string;
  taskId: string;
  status: ProposalStatus;
  change: ProposalChange;
  /** Guard against applying a proposal built on a stale revision. */
  expectedBriefVersion: number;
  expectedGrantVersion: number;
  reason: string;
  createdAt: string;
  decidedAt: string | null;
}

export class ProposalConflictError extends Error {
  override readonly name = "ProposalConflictError";
  constructor(readonly code: "not_pending" | "stale_revision", message: string) {
    super(message);
  }
}

export class ProposalStore {
  constructor(private readonly db: Database) {}

  create(input: Omit<Proposal, "proposalId" | "status" | "createdAt" | "decidedAt">): Proposal {
    const proposalId = newId();
    const createdAt = toIso(new Date());
    this.db
      .prepare(
        `INSERT INTO proposals (proposal_id, task_id, status, change_json, expected_brief_version, expected_grant_version,
           reason, created_at, decided_at)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        proposalId,
        input.taskId,
        JSON.stringify(input.change),
        input.expectedBriefVersion,
        input.expectedGrantVersion,
        input.reason,
        createdAt,
      );
    return this.get(proposalId)!;
  }

  get(proposalId: string): Proposal | undefined {
    const row = this.db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId) as ProposalRow | undefined;
    return row ? toProposal(row) : undefined;
  }

  listPending(taskId?: string): Proposal[] {
    const rows = taskId
      ? (this.db.prepare("SELECT * FROM proposals WHERE status = 'pending' AND task_id = ? ORDER BY created_at").all(taskId) as ProposalRow[])
      : (this.db.prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at").all() as ProposalRow[]);
    return rows.map(toProposal);
  }

  /**
   * Marks the proposal confirmed *before* the caller applies it, so a crash
   * between the two leaves a confirmed-but-unapplied proposal that is visible
   * for recovery rather than a silent half-change.
   */
  markConfirmed(proposalId: string, now = toIso(new Date())): Proposal {
    return this.decide(proposalId, "confirmed", now);
  }

  markCancelled(proposalId: string, now = toIso(new Date())): Proposal {
    return this.decide(proposalId, "cancelled", now);
  }

  private decide(proposalId: string, status: ProposalStatus, now: string): Proposal {
    const current = this.get(proposalId);
    if (!current) throw new ProposalConflictError("not_pending", `proposal ${proposalId} not found`);
    if (current.status !== "pending") throw new ProposalConflictError("not_pending", `proposal ${proposalId} is ${current.status}`);
    this.db.prepare("UPDATE proposals SET status = ?, decided_at = ? WHERE proposal_id = ?").run(status, now, proposalId);
    return this.get(proposalId)!;
  }
}

interface ProposalRow {
  proposal_id: string;
  task_id: string;
  status: ProposalStatus;
  change_json: string;
  expected_brief_version: number;
  expected_grant_version: number;
  reason: string;
  created_at: string;
  decided_at: string | null;
}

function toProposal(row: ProposalRow): Proposal {
  return {
    proposalId: row.proposal_id,
    taskId: row.task_id,
    status: row.status,
    change: JSON.parse(row.change_json) as ProposalChange,
    expectedBriefVersion: Number(row.expected_brief_version),
    expectedGrantVersion: Number(row.expected_grant_version),
    reason: row.reason,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

/** Maps an inbox decision key to the proposal outcome it should trigger. */
export function proposalDecisionKey(): DecisionKey {
  return "decision_required";
}
