import type { StandingPolicy, Tier } from "./policy.js";

export interface AuthorizationRequest {
  action: string;
  environment?: string | null;
  resource?: string | null;
}

export type Decision =
  /** Allowed with no prompt and no new grant needed. */
  | { kind: "allow"; tier: 0 }
  /** The chief of staff may grant this silently; a new GrantRevision is issued. */
  | { kind: "auto_grant"; tier: 1 }
  /** A red line: the task must pause and ask the human. */
  | { kind: "needs_human"; tier: 2; reason: string }
  /** Outside the policy entirely and not fatal; caller decides how to surface it. */
  | { kind: "deny"; reason: string };

/**
 * Maps one authorization request to a tier. Red lines are matched first, so a
 * broad Tier 1 rule can never widen a Tier 2 action. A request that matches no
 * rule at all falls back to `denyUnknownAsTier2` (ask the human) rather than
 * being silently allowed.
 */
export class AuthorizationEvaluator {
  constructor(private readonly policy: StandingPolicy) {}

  classify(request: AuthorizationRequest): Decision {
    const redLine = this.match(this.policy.tier2, request);
    if (redLine) {
      return {
        kind: "needs_human",
        tier: 2,
        reason: `${request.action}${scopeOf(request)} is a red line that only the user may approve`,
      };
    }
    if (this.match(this.policy.tier0, request)) return { kind: "allow", tier: 0 };
    if (this.match(this.policy.tier1, request)) return { kind: "auto_grant", tier: 1 };
    if (this.policy.denyUnknownAsTier2) {
      return {
        kind: "needs_human",
        tier: 2,
        reason: `${request.action}${scopeOf(request)} is not covered by the standing policy; asking the user`,
      };
    }
    return { kind: "deny", reason: `${request.action}${scopeOf(request)} is not delegated` };
  }

  tierOf(request: AuthorizationRequest): Tier | "unknown" {
    const decision = this.classify(request);
    return decision.kind === "deny" ? "unknown" : decision.tier;
  }

  private match(rules: StandingPolicy["tier0"], request: AuthorizationRequest): boolean {
    return rules.some(
      (rule) =>
        rule.action === request.action &&
        matchesScope(rule.environment, request.environment) &&
        matchesScope(rule.resource, request.resource),
    );
  }
}

/** A null rule scope means "any"; a null request scope only matches a null rule. */
function matchesScope(ruleScope: string | null | undefined, requestScope: string | null | undefined): boolean {
  if (ruleScope === null || ruleScope === undefined) return true;
  return ruleScope === (requestScope ?? null);
}

function scopeOf(request: AuthorizationRequest): string {
  const parts = [request.environment, request.resource].filter((value): value is string => typeof value === "string");
  return parts.length > 0 ? ` (${parts.join("/")})` : "";
}
