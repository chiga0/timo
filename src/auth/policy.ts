/**
 * Standing policy: the user's standing delegation to the chief of staff.
 *
 * Three tiers (docs/architecture.md "三层授权体系"):
 * - Tier 0 — default pass, no approval prompt (worktree writes, local tests,
 *   registered staging log reads, CI status).
 * - Tier 1 — the chief of staff may grant on its own, silently, inside the
 *   user's pre-delegated scope.
 * - Tier 2 — permanent red lines: always ask the human, never auto-approve.
 *
 * Security posture: the defaults are deliberately conservative. Tier 2 is
 * matched first, so a broad Tier 1 pattern can never widen a red line.
 */

export type Tier = 0 | 1 | 2;

export interface PolicyRule {
  /** Action identifier, e.g. `read_logs`, `open_pull_request`, `deploy_prod`. */
  action: string;
  /** Optional environment scope: `dev`, `staging`, `prod`. Absent means any. */
  environment?: string | null;
  /** Optional resource scope: repo, project, cluster name. Absent means any. */
  resource?: string | null;
}

export interface StandingPolicy {
  version: number;
  /** Actions allowed with no approval prompt at all. */
  tier0: PolicyRule[];
  /** Actions the chief of staff may grant silently, inside the user's delegation. */
  tier1: PolicyRule[];
  /** Red lines: always require a human decision. */
  tier2: PolicyRule[];
  /** Per-task budget ceilings referenced by the evaluator. */
  budget: {
    /** Wall-clock ceiling for one task, in minutes. */
    maxRunMinutes: number;
    /** Ceiling on total executor attempts for one task. */
    maxAttempts: number;
  };
  /** When true, an unknown action is treated as a red line instead of denied. */
  denyUnknownAsTier2: boolean;
}

/**
 * Defaults applied when `~/.timo/policy.json` is absent or a field is missing.
 * A missing policy file must still be safe: no Tier 1 broad delegation, and
 * every production action is a red line.
 */
export const DEFAULT_POLICY: StandingPolicy = {
  version: 1,
  tier0: [
    { action: "read_worktree" },
    { action: "write_worktree" },
    { action: "run_local_tests" },
    { action: "run_build" },
    { action: "read_ci_status" },
    { action: "read_logs", environment: "staging" },
  ],
  tier1: [
    { action: "open_pull_request", environment: "dev" },
    { action: "read_logs", environment: "dev" },
    { action: "read_repo", environment: "dev" },
  ],
  tier2: [
    { action: "deploy_prod" },
    { action: "merge_main" },
    { action: "write_prod" },
    { action: "read_prod_sensitive_data" },
    { action: "read_prod_logs" },
    { action: "delete_cloud_resource" },
    { action: "read_cross_repo" },
    { action: "exceed_budget" },
  ],
  budget: { maxRunMinutes: 120, maxAttempts: 5 },
  denyUnknownAsTier2: true,
};

export type PolicySource = "file" | "default";

export interface LoadedPolicy {
  policy: StandingPolicy;
  source: PolicySource;
  /** Populated when the file existed but was rejected; the defaults then apply. */
  warning?: string;
}

/**
 * Loads and validates the policy. An invalid file is never half-applied: the
 * whole document falls back to `DEFAULT_POLICY` so a typo cannot silently
 * widen the delegation.
 */
export function parsePolicy(raw: unknown): LoadedPolicy {
  if (!isRecord(raw)) return { policy: clonePolicy(DEFAULT_POLICY), source: "default" };
  try {
    const policy: StandingPolicy = {
      version: typeof raw.version === "number" ? raw.version : DEFAULT_POLICY.version,
      tier0: parseRules(raw.tier0, "tier0"),
      tier1: parseRules(raw.tier1, "tier1"),
      tier2: parseRules(raw.tier2, "tier2"),
      budget: parseBudget(raw.budget),
      denyUnknownAsTier2: typeof raw.denyUnknownAsTier2 === "boolean" ? raw.denyUnknownAsTier2 : DEFAULT_POLICY.denyUnknownAsTier2,
    };
    return finish(policy, "file");
  } catch (error) {
    return {
      policy: clonePolicy(DEFAULT_POLICY),
      source: "default",
      warning: `policy.json rejected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * A red-line action must never also be listed in Tier 0/1. Silently dropping the
 * overlap would make the outcome depend on rule order, so it is rejected loudly
 * and the safe defaults apply instead.
 */
function finish(policy: StandingPolicy, source: PolicySource): LoadedPolicy {
  const redLines = new Set(policy.tier2.map((rule) => rule.action));
  for (const tier of ["tier0", "tier1"] as const) {
    for (const rule of policy[tier]) {
      if (redLines.has(rule.action)) {
        return {
          policy: clonePolicy(DEFAULT_POLICY),
          source: "default",
          warning: `policy.json rejected: ${rule.action} is both a Tier 2 red line and listed in ${tier}`,
        };
      }
    }
  }
  return { policy, source };
}

function parseRules(raw: unknown, field: string): PolicyRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${field} must be an array`);
  return raw.map((item, index) => {
    if (!isRecord(item) || typeof item.action !== "string" || item.action.trim() === "") {
      throw new Error(`${field}[${index}] needs a non-empty string action`);
    }
    return {
      action: item.action,
      environment: typeof item.environment === "string" ? item.environment : null,
      resource: typeof item.resource === "string" ? item.resource : null,
    };
  });
}

function parseBudget(raw: unknown): StandingPolicy["budget"] {
  if (raw === undefined) return { ...DEFAULT_POLICY.budget };
  if (!isRecord(raw)) throw new Error("budget must be an object");
  const maxRunMinutes = typeof raw.maxRunMinutes === "number" && raw.maxRunMinutes > 0 ? raw.maxRunMinutes : DEFAULT_POLICY.budget.maxRunMinutes;
  const maxAttempts = typeof raw.maxAttempts === "number" && raw.maxAttempts > 0 ? raw.maxAttempts : DEFAULT_POLICY.budget.maxAttempts;
  return { maxRunMinutes, maxAttempts };
}

function clonePolicy(policy: StandingPolicy): StandingPolicy {
  return JSON.parse(JSON.stringify(policy)) as StandingPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One-line human summary for the auth-health panel and audit records. */
export function describePolicy(policy: StandingPolicy): string {
  return `tier0=${policy.tier0.length} tier1=${policy.tier1.length} tier2=${policy.tier2.length} unknown=${policy.denyUnknownAsTier2 ? "tier2" : "deny"}`;
}
