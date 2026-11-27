import type { CapabilityMcpGateway } from "./mcp-gateway.js";
import type { TaskStore } from "../store/tasks.js";
import { stableRequestId } from "../store/tasks.js";
import type { TaskService } from "../service/task-service.js";
import {
  PlatformEffectUnknownError,
  redactLogText,
  type MrReceipt,
  type PlatformAdapter,
} from "../platform/adapter.js";
import type { StepOutcome, VerificationContext, VerificationStep } from "../verify/pipeline.js";
import { toIso } from "../util.js";

export interface PlatformToolsDeps {
  store: TaskStore;
  service: TaskService;
  platform: PlatformAdapter;
  maxLogBytes?: number;
}

/**
 * Registers the Step 4.2 controlled business tools on the local Capability MCP
 * Gateway:
 * - `timo_read_logs`: scoped read-only log queries with secret redaction & size cap;
 * - `timo_create_or_update_mr`: Intent-Before-Effect MR submission with durable
 *   idempotency key, receipt persistence, and `effect_unknown` guard;
 * - `timo_deploy_prod`: red-line gated tool (pruned from `tools/list` unless
 *   explicitly granted by a human).
 */
export function registerPlatformTools(gateway: CapabilityMcpGateway, deps: PlatformToolsDeps): void {
  const maxLogBytes = deps.maxLogBytes ?? 16 * 1024;

  gateway.registerTool({
    name: "timo_read_logs",
    description: "Read-only query of scoped application logs (redacted and size-capped).",
    requiredAction: "read_logs",
    requiredEnvironment: "staging",
    inputSchema: {
      type: "object",
      properties: {
        environment: { type: "string", description: "Target environment: dev, staging, or prod" },
        service: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        limit: { type: "number" },
      },
      required: ["environment"],
    },
    handler: async (args, ctx) => {
      const environment = typeof args.environment === "string" ? args.environment.trim() : "";
      if (environment === "") {
        return { isError: true, data: { code: "INVALID_INPUT", message: "environment is required" } };
      }

      // Enforce environment scope: production logs require explicit `read_prod_logs` grant!
      if (environment === "prod") {
        const view = ctx.service.getTaskView(ctx.taskId);
        const hasProdGrant = view?.grants.some((g) => g.action === "read_prod_logs") === true;
        if (!hasProdGrant) {
          return {
            isError: true,
            data: {
              code: "PERMISSION_DENIED",
              requiredAction: "read_prod_logs",
              message: "reading prod logs is a Tier 2 red line; request grant via timo_request_grant first",
            },
          };
        }
      }

      const result = await deps.platform.readLogs(
        {
          environment,
          service: typeof args.service === "string" ? args.service : undefined,
          since: typeof args.since === "string" ? args.since : undefined,
          until: typeof args.until === "string" ? args.until : undefined,
          limit: typeof args.limit === "number" ? args.limit : 100,
        },
        ctx.credentials,
      );

      let totalBytes = 0;
      let redactedCount = 0;
      let capped = result.truncated;
      const safeLines: string[] = [];
      for (const line of result.lines) {
        const cleaned = redactLogText(line);
        if (cleaned.redacted) redactedCount += 1;
        const size = Buffer.byteLength(cleaned.text, "utf8");
        if (totalBytes + size > maxLogBytes) {
          capped = true;
          break;
        }
        totalBytes += size;
        safeLines.push(cleaned.text);
      }

      return {
        data: {
          environment,
          lines: safeLines,
          lineCount: safeLines.length,
          redactedCount,
          truncated: capped,
        },
      };
    },
  });

  gateway.registerTool({
    name: "timo_create_or_update_mr",
    description: "Create or update an MR/PR for a task repository using Intent-Before-Effect and a stable idempotency key.",
    requiredAction: "open_pull_request",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository name in this task" },
        title: { type: "string" },
        body: { type: "string" },
        headSha: { type: "string", description: "Exact candidate commit SHA to bind to the MR" },
      },
      required: ["repo", "title"],
    },
    handler: async (args, ctx) => {
      const repoName = typeof args.repo === "string" ? args.repo.trim() : "";
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const body = typeof args.body === "string" ? args.body : "";
      if (!repoName || !title) {
        return { isError: true, data: { code: "INVALID_INPUT", message: "repo and title are required" } };
      }

      const view = ctx.service.getTaskView(ctx.taskId);
      if (!view) {
        return { isError: true, data: { code: "TASK_NOT_FOUND", message: `task ${ctx.taskId} not found` } };
      }
      const repoState = view.task.repos.find((r) => r.name === repoName);
      if (!repoState) {
        return { isError: true, data: { code: "REPO_NOT_FOUND", message: `repo ${repoName} is not part of task ${ctx.taskId}` } };
      }

      const headSha = (typeof args.headSha === "string" && args.headSha.trim() !== "" ? args.headSha.trim() : repoState.headSha) ?? "";
      if (!headSha) {
        return { isError: true, data: { code: "MISSING_HEAD_SHA", message: `repo ${repoName} has no candidate headSha` } };
      }

      const kind = `mr:${repoName}`;
      const operationKey = `${ctx.taskId}:mr:${repoName}`;
      const clientRequestId = stableRequestId(operationKey);
      const operationId = `${ctx.taskId}:mr:${repoName}`;
      const now = toIso(new Date());

      // Step 1: Intent-Before-Effect — persist operation row before any platform I/O.
      const { operation } = deps.store.ensureOperationIntent({
        operationId,
        taskId: ctx.taskId,
        kind,
        operationKey,
        clientRequestId,
        payload: {
          repo: repoName,
          branch: repoState.branch ?? `timo/${ctx.taskId.slice(0, 8)}/${repoName}`,
          baseRef: repoState.baseRef,
          headSha,
          title,
        },
        now,
      });

      // Step 2: Refuse blind resend when prior outcome is unknown.
      if (operation.status === "unknown") {
        return {
          isError: true,
          data: {
            code: "EFFECT_UNKNOWN",
            operationId: operation.operationId,
            operationKey: operation.operationKey,
            message: `MR operation for ${repoName} is in effect_unknown; reconcile with platform before retrying`,
          },
        };
      }

      // Step 3: If already completed for this exact SHA, reuse saved receipt (zero duplicates!).
      const existingReceipt = operation.receipt as MrReceipt | null;
      if (operation.status === "done" && existingReceipt && existingReceipt.headSha === headSha) {
        return { data: { reused: true, operationId: operation.operationId, receipt: existingReceipt } };
      }

      // Step 4: Mark in_flight before external network call (never hold DB tx across I/O).
      deps.store.setOperationStatus(operation.operationId, "in_flight", undefined, now);
      const attemptId = `${operation.operationId}:a:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;

      try {
        const receipt = await deps.platform.createOrUpdateMr(
          {
            repo: repoName,
            branch: repoState.branch ?? `timo/${ctx.taskId.slice(0, 8)}/${repoName}`,
            baseRef: repoState.baseRef,
            headSha,
            title,
            body,
            clientRequestId,
          },
          ctx.credentials,
        );
        const doneAt = toIso(new Date());
        deps.store.setOperationStatus(operation.operationId, "done", receipt, doneAt);
        deps.store.recordAttempt(attemptId, operation.operationId, null, receipt, doneAt);

        // Update repo delivery state with the durable MR receipt.
        const freshView = ctx.service.getTaskView(ctx.taskId);
        if (freshView) {
          const nextRepos = freshView.task.repos.map((r) =>
            r.name === repoName
              ? { ...r, headSha, mrId: receipt.mrId, mrUrl: receipt.url, mrHeadSha: receipt.headSha, ciStatus: r.ciStatus ?? "pending" }
              : r,
          );
          ctx.service.updateRepoStates(ctx.taskId, nextRepos);
        }
        return { data: { reused: false, operationId: operation.operationId, receipt } };
      } catch (error) {
        const errAt = toIso(new Date());
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof PlatformEffectUnknownError) {
          deps.store.setOperationStatus(operation.operationId, "unknown", { error: message, headSha, repo: repoName }, errAt);
          deps.store.recordAttempt(attemptId, operation.operationId, "effect_unknown", { error: message }, errAt);
          ctx.service.markWaiting(ctx.taskId, "effect_unknown", errAt);
          return {
            isError: true,
            data: {
              code: "EFFECT_UNKNOWN",
              operationId: operation.operationId,
              operationKey,
              message,
            },
          };
        }
        deps.store.setOperationStatus(operation.operationId, "failed", { error: message }, errAt);
        deps.store.recordAttempt(attemptId, operation.operationId, "platform_rejected", { error: message }, errAt);
        return {
          isError: true,
          data: { code: "MR_FAILED", operationId: operation.operationId, message },
        };
      }
    },
  });

  // Registered intentionally with Tier 2 `deploy_prod` guard so Tool Visibility
  // Pruning hides it from `tools/list` whenever production deploy is forbidden.
  gateway.registerTool({
    name: "timo_deploy_prod",
    description: "Deploy a release to production (Tier 2 red line — hidden unless explicitly granted by human).",
    requiredAction: "deploy_prod",
    requiredEnvironment: "prod",
    inputSchema: {
      type: "object",
      properties: {
        releaseId: { type: "string" },
      },
      required: ["releaseId"],
    },
    handler: async (args) => {
      return { data: { deployed: true, releaseId: String(args.releaseId ?? "") } };
    },
  });
}

/**
 * Reconciles an `effect_unknown` MR operation by querying the platform with the
 * original stable `clientRequestId`. If found, binds the receipt and moves the
 * operation to `done`; if not found, preserves `unknown` without blind resend.
 */
export async function reconcileMrOperation(
  operationId: string,
  deps: { store: TaskStore; service: TaskService; platform: PlatformAdapter; credentials?: Record<string, string | undefined> },
): Promise<{
  operationId: string;
  reconciled: boolean;
  status: string;
  receipt: MrReceipt | null;
  message: string;
}> {
  const op = deps.store.getOperationById(operationId);
  if (!op) throw new Error(`operation ${operationId} not found`);
  const repo = typeof op.payload.repo === "string" ? op.payload.repo : "";
  const now = toIso(new Date());

  const found = await deps.platform.findMrByOperationKey(repo, op.clientRequestId, deps.credentials);
  if (found) {
    deps.store.setOperationStatus(op.operationId, "done", found, now, now);
    const view = deps.service.getTaskView(op.taskId);
    if (view) {
      const nextRepos = view.task.repos.map((r) =>
        r.name === repo
          ? { ...r, mrId: found.mrId, mrUrl: found.url, mrHeadSha: found.headSha, ciStatus: r.ciStatus ?? "pending" }
          : r,
      );
      deps.service.updateRepoStates(op.taskId, nextRepos);
    }
    return {
      operationId: op.operationId,
      reconciled: true,
      status: "done",
      receipt: found,
      message: `reconciled existing MR ${found.mrId} for ${repo} without creating a duplicate`,
    };
  }

  // Still cannot confirm on platform: stay in `unknown`, never blindly resend.
  deps.store.setOperationStatus(op.operationId, "unknown", undefined, now, now);
  return {
    operationId: op.operationId,
    reconciled: false,
    status: "unknown",
    receipt: null,
    message: `no MR found for operationKey=${op.operationKey ?? op.clientRequestId}; staying in effect_unknown`,
  };
}

/**
 * `platform_mr` verification step handler (Step 4.2):
 * - Verifies that the repo has a confirmed MR receipt bound to the exact latest candidate SHA;
 * - Polls external CI status with 0 model calls;
 * - Rejects green CI whose `headSha` does NOT match the latest candidate SHA!
 * - Returns `waiting_external` while CI is pending so the task parks in
 *   `waiting(waiting_external_ci)` and Outbox polls at 0-Token cost.
 */
export function createPlatformMrVerifier(deps: {
  store: TaskStore;
  service: TaskService;
  platform: PlatformAdapter;
  credentials?: Record<string, string | undefined>;
}): NonNullable<VerificationContext["platformVerifier"]> {
  return async (step: Extract<VerificationStep, { type: "platform_mr" }>, context: VerificationContext): Promise<StepOutcome> => {
    const stepName = step.name ?? `platform_mr:${step.repo}`;
    const repo = (context.repos ?? []).find((r) => r.name === step.repo);
    if (!repo) {
      return {
        stepName,
        stepType: "platform_mr",
        status: "rejected",
        verifierVersion: "platform-mr-v1",
        findings: [{ code: "repo_not_found", detail: `repo ${step.repo} not present in task` }],
      };
    }

    const op = deps.store.getOperation(context.taskId, `mr:${step.repo}`);
    if (!op) {
      return {
        stepName,
        stepType: "platform_mr",
        status: "rejected",
        verifierVersion: "platform-mr-v1",
        boundCommits: { [repo.name]: repo.headSha },
        findings: [{ code: "mr_missing", detail: `no MR operation recorded for ${step.repo}` }],
      };
    }
    if (op.status === "unknown") {
      return {
        stepName,
        stepType: "platform_mr",
        status: "rejected",
        verifierVersion: "platform-mr-v1",
        boundCommits: { [repo.name]: repo.headSha },
        findings: [{ code: "effect_unknown", detail: `MR operation ${op.operationId} is in effect_unknown` }],
      };
    }
    const receipt = op.receipt as MrReceipt | null;
    if (op.status !== "done" || !receipt || !receipt.mrId) {
      return {
        stepName,
        stepType: "platform_mr",
        status: "rejected",
        verifierVersion: "platform-mr-v1",
        boundCommits: { [repo.name]: repo.headSha },
        findings: [{ code: "mr_not_ready", detail: `MR operation for ${step.repo} has status ${op.status}` }],
      };
    }

    // MR receipt must correspond to the exact latest candidate SHA.
    if (receipt.headSha !== repo.headSha) {
      updateRepoCi(deps.service, context.taskId, step.repo, { ciStatus: "stale", ciHeadSha: receipt.headSha });
      return {
        stepName,
        stepType: "platform_mr",
        status: "rejected",
        verifierVersion: "platform-mr-v1",
        boundCommits: { [repo.name]: repo.headSha },
        findings: [
          {
            code: "stale_mr_sha",
            detail: `MR ${receipt.mrId} is at ${receipt.headSha.slice(0, 10)} but latest candidate is ${repo.headSha.slice(0, 10)}`,
          },
        ],
      };
    }

    const ci = await deps.platform.getCiStatus(
      { repo: step.repo, mrId: receipt.mrId, expectedHeadSha: repo.headSha },
      deps.credentials,
    );

    // Crucial S05 / Step 4.2 rule: green CI on an OLDER SHA must be rejected!
    if (ci.headSha !== repo.headSha) {
      updateRepoCi(deps.service, context.taskId, step.repo, {
        ciStatus: "stale",
        ciHeadSha: ci.headSha,
        ciChecks: ci.checks,
      });
      return {
        stepName,
        stepType: "platform_mr",
        status: "rejected",
        verifierVersion: "platform-mr-v1",
        boundCommits: { [repo.name]: repo.headSha },
        findings: [
          {
            code: "stale_ci_sha",
            detail: `CI status (${ci.status}) for MR ${receipt.mrId} is bound to older SHA ${ci.headSha.slice(0, 10)}, expected ${repo.headSha.slice(0, 10)}`,
          },
        ],
      };
    }

    // Verify required checks if declared.
    if (step.requiredChecks && step.requiredChecks.length > 0) {
      for (const reqCheck of step.requiredChecks) {
        const found = ci.checks.find((c) => c.name === reqCheck);
        if (!found || found.status === "queued" || found.status === "in_progress") {
          updateRepoCi(deps.service, context.taskId, step.repo, { ciStatus: "pending", ciHeadSha: ci.headSha, ciChecks: ci.checks });
          return {
            stepName,
            stepType: "platform_mr",
            status: "waiting_external",
            verifierVersion: "platform-mr-v1",
            boundCommits: { [repo.name]: repo.headSha },
            findings: [],
          };
        }
        if (found.status === "failed") {
          updateRepoCi(deps.service, context.taskId, step.repo, { ciStatus: "failed", ciHeadSha: ci.headSha, ciChecks: ci.checks });
          return {
            stepName,
            stepType: "platform_mr",
            status: "rejected",
            verifierVersion: "platform-mr-v1",
            boundCommits: { [repo.name]: repo.headSha },
            findings: [{ code: "ci_check_failed", detail: `required CI check ${reqCheck} failed on ${step.repo}` }],
          };
        }
      }
    }

    if (ci.status === "pending") {
      updateRepoCi(deps.service, context.taskId, step.repo, { ciStatus: "pending", ciHeadSha: ci.headSha, ciChecks: ci.checks });
      return {
        stepName,
        stepType: "platform_mr",
        status: "waiting_external",
        verifierVersion: "platform-mr-v1",
        boundCommits: { [repo.name]: repo.headSha },
        findings: [],
      };
    }

    if (ci.status === "failed") {
      updateRepoCi(deps.service, context.taskId, step.repo, { ciStatus: "failed", ciHeadSha: ci.headSha, ciChecks: ci.checks });
      return {
        stepName,
        stepType: "platform_mr",
        status: "rejected",
        verifierVersion: "platform-mr-v1",
        boundCommits: { [repo.name]: repo.headSha },
        findings: [{ code: "ci_failed", detail: `CI failed for MR ${receipt.mrId} on ${step.repo}` }],
      };
    }

    updateRepoCi(deps.service, context.taskId, step.repo, { ciStatus: "passed", ciHeadSha: ci.headSha, ciChecks: ci.checks });
    return {
      stepName,
      stepType: "platform_mr",
      status: "accepted",
      verifierVersion: "platform-mr-v1",
      boundCommits: { [repo.name]: repo.headSha },
      findings: [],
      detail: { mrId: receipt.mrId, mrUrl: receipt.url, headSha: ci.headSha, checks: ci.checks },
    };
  };
}

function updateRepoCi(
  service: TaskService,
  taskId: string,
  repoName: string,
  patch: { ciStatus: "pending" | "passed" | "failed" | "stale" | "unknown"; ciHeadSha: string; ciChecks?: Array<{ name: string; status: string }> },
): void {
  const view = service.getTaskView(taskId);
  if (!view) return;
  const next = view.task.repos.map((r) => (r.name === repoName ? { ...r, ...patch } : r));
  service.updateRepoStates(taskId, next);
}
