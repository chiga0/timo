import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCandidate, SSE_VERIFIER_VERSION } from "../sse/contract.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { sha256Hex, stableJson } from "../util.js";

/** Generic structured verification finding across all verifier plugins. */
export interface VerificationFinding {
  code: string;
  detail: string;
}

/**
 * Declarative verification pipeline (Step 3.3 + Step 4.2).
 *
 * Keeps `TaskService` decoupled from any single verification kind:
 * - `log_citation`: the deterministic `sse-v1` log verifier;
 * - `command_check`: checks out the frozen candidate SHA(s) into a brand-new
 *   isolated directory and runs the declared verification command(s);
 * - `platform_mr`: validates MR & CI checks against the exact candidate SHA
 *   (registered in Step 4.2).
 */

export type VerificationStep =
  | {
      type: "log_citation";
      name?: string;
    }
  | {
      type: "command_check";
      name?: string;
      /** Shell command run inside the clean checkout (e.g. `npm run typecheck && npm test`). */
      command: string;
      /** Single repo name to run inside, or omitted for a multi-repo combo root. */
      repo?: string;
      /** True when this check validates a multi-repo combination together. */
      combo?: boolean;
      timeoutMs?: number;
    }
  | {
      type: "platform_mr";
      name?: string;
      repo: string;
      requiredChecks?: string[];
    };

export interface VerificationPlan {
  version: string;
  steps: VerificationStep[];
}

export interface RepoCandidateRef {
  name: string;
  sourcePath: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  worktreePath?: string;
  branch?: string;
}

export interface VerificationContext {
  taskId: string;
  briefVersion: number;
  /** For `log_citation` tasks. */
  frozenLog?: Uint8Array | null;
  inputDigest?: string;
  candidate?: unknown;
  /** For `repo_delivery` tasks: exact frozen commits per repo. */
  repos?: RepoCandidateRef[];
  /** WorkspaceManager used to materialize clean isolated checkouts. */
  workspaces?: WorkspaceManager;
  /** Optional root directory for isolated verification checkouts. */
  verifyTmpRoot?: string;
  /** Extension slot for Step 4.2 `platform_mr` verifier. */
  platformVerifier?: (
    step: Extract<VerificationStep, { type: "platform_mr" }>,
    context: VerificationContext,
  ) => Promise<StepOutcome>;
}

export interface StepOutcome {
  stepName: string;
  stepType: VerificationStep["type"];
  status: "accepted" | "rejected" | "incomplete" | "waiting_external";
  verifierVersion: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  /** Exact repo SHAs bound to this verification step. */
  boundCommits?: Record<string, string>;
  findings: VerificationFinding[];
  /** Optional structured seal (e.g. from `log_citation`). */
  detail?: unknown;
}

export interface PipelineOutcome {
  status: "accepted" | "rejected" | "incomplete" | "waiting_external";
  verifierVersion: string;
  candidateDigest: string;
  boundCommits: Record<string, string>;
  steps: StepOutcome[];
  findings: VerificationFinding[];
}

export type StepVerifier<S extends VerificationStep = VerificationStep> = (
  step: S,
  context: VerificationContext,
) => Promise<StepOutcome>;

/** Canonical digest of a repo candidate combination (sorted repo -> exact headSha). */
export function computeRepoCandidateDigest(repos: ReadonlyArray<{ name: string; headSha: string }>): string {
  const ordered: Record<string, string> = {};
  for (const repo of [...repos].sort((a, b) => a.name.localeCompare(b.name))) {
    ordered[repo.name] = repo.headSha;
  }
  return sha256Hex(Buffer.from(stableJson(ordered), "utf8"));
}

export class VerifierRegistry {
  private readonly handlers = new Map<VerificationStep["type"], StepVerifier>();

  constructor() {
    this.register("log_citation", verifyLogCitation);
    this.register("command_check", verifyCommandCheck);
    this.register("platform_mr", verifyPlatformMr);
  }

  register<T extends VerificationStep["type"]>(
    type: T,
    handler: StepVerifier<Extract<VerificationStep, { type: T }>>,
  ): void {
    this.handlers.set(type, handler as StepVerifier);
  }

  has(type: VerificationStep["type"]): boolean {
    return this.handlers.has(type);
  }

  async run(plan: VerificationPlan, context: VerificationContext): Promise<PipelineOutcome> {
    if (!plan.steps || plan.steps.length === 0) {
      return {
        status: "rejected",
        verifierVersion: plan.version,
        candidateDigest: computeContextDigest(context),
        boundCommits: commitsMap(context.repos),
        steps: [],
        findings: [{ code: "empty_verification_plan", detail: "verification plan has no steps" }],
      };
    }

    const steps: StepOutcome[] = [];
    const findings: VerificationFinding[] = [];
    let overall: PipelineOutcome["status"] = "accepted";

    for (const step of plan.steps) {
      const handler = this.handlers.get(step.type);
      if (!handler) {
        const outcome: StepOutcome = {
          stepName: step.name ?? step.type,
          stepType: step.type,
          status: "rejected",
          verifierVersion: "unknown",
          findings: [{ code: "verifier_missing", detail: `no verifier registered for ${step.type}` }],
        };
        steps.push(outcome);
        findings.push(...outcome.findings);
        overall = "rejected";
        continue;
      }

      const outcome = await handler(step, context);
      steps.push(outcome);
      findings.push(...outcome.findings);
      if (outcome.status === "rejected") {
        overall = "rejected";
      } else if (outcome.status === "incomplete" && overall !== "rejected") {
        overall = "incomplete";
      } else if (outcome.status === "waiting_external" && overall === "accepted") {
        overall = "waiting_external";
      }
    }

    return {
      status: overall,
      verifierVersion: plan.version,
      candidateDigest: computeContextDigest(context),
      boundCommits: commitsMap(context.repos),
      steps,
      findings,
    };
  }
}

function commitsMap(repos?: RepoCandidateRef[]): Record<string, string> {
  const map: Record<string, string> = {};
  if (!repos) return map;
  for (const repo of [...repos].sort((a, b) => a.name.localeCompare(b.name))) {
    map[repo.name] = repo.headSha;
  }
  return map;
}

function computeContextDigest(context: VerificationContext): string {
  if (context.repos && context.repos.length > 0) {
    return computeRepoCandidateDigest(context.repos);
  }
  return sha256Hex(Buffer.from(stableJson(context.candidate ?? null), "utf8"));
}

async function verifyLogCitation(
  step: Extract<VerificationStep, { type: "log_citation" }>,
  context: VerificationContext,
): Promise<StepOutcome> {
  if (!context.frozenLog) {
    return {
      stepName: step.name ?? "log_citation",
      stepType: "log_citation",
      status: "rejected",
      verifierVersion: SSE_VERIFIER_VERSION,
      findings: [{ code: "artifact_missing", detail: "frozen log input is missing" }],
    };
  }
  const outcome = verifyCandidate(context.frozenLog, context.inputDigest ?? "", context.candidate);
  return {
    stepName: step.name ?? "log_citation",
    stepType: "log_citation",
    status: outcome.status,
    verifierVersion: SSE_VERIFIER_VERSION,
    findings: outcome.status === "accepted" ? [] : outcome.findings,
    detail:
      outcome.status === "accepted"
        ? {
            verdict: outcome.expected.verdict,
            incidents: outcome.expected.incidents,
            inputDigest: outcome.digest,
            verifierVersion: outcome.verifierVersion,
          }
        : undefined,
  };
}

/**
 * Independent command verifier. Materializes a clean detached git worktree at
 * the exact candidate SHA(s) so dirty files or self-reported "tests passed"
 * artifacts in the author's workspace can never fool verification.
 */
async function verifyCommandCheck(
  step: Extract<VerificationStep, { type: "command_check" }>,
  context: VerificationContext,
): Promise<StepOutcome> {
  const stepName = step.name ?? (step.combo ? "combo_command_check" : `command_check:${step.repo ?? "workspace"}`);
  const repos = context.repos ?? [];
  if (repos.length === 0) {
    return {
      stepName,
      stepType: "command_check",
      status: "rejected",
      verifierVersion: "command-check-v1",
      findings: [{ code: "missing_repos", detail: "command_check requires at least one repo candidate" }],
    };
  }
  if (!context.workspaces) {
    return {
      stepName,
      stepType: "command_check",
      status: "rejected",
      verifierVersion: "command-check-v1",
      findings: [{ code: "missing_workspace_manager", detail: "WorkspaceManager is required for isolated command_check" }],
    };
  }

  const targetRepos = step.repo ? repos.filter((repo) => repo.name === step.repo) : repos;
  if (targetRepos.length === 0) {
    return {
      stepName,
      stepType: "command_check",
      status: "rejected",
      verifierVersion: "command-check-v1",
      findings: [{ code: "repo_not_found", detail: `repo ${step.repo} not present in task candidate` }],
    };
  }

  const baseRoot = context.verifyTmpRoot ?? tmpdir();
  const isolatedRoot = mkdtempSync(join(baseRoot, "timo-verify-"));
  const checkedOut: Array<{ sourcePath: string; targetDir: string }> = [];
  const linkedDeps: string[] = [];
  const boundCommits: Record<string, string> = {};
  const startedAt = Date.now();

  try {
    let runCwd = isolatedRoot;
    for (const repo of targetRepos) {
      const targetDir = targetRepos.length === 1 && !step.combo ? join(isolatedRoot, "repo") : join(isolatedRoot, repo.name);
      context.workspaces.materializeCleanCheckout(repo.sourcePath, repo.headSha, targetDir);
      checkedOut.push({ sourcePath: repo.sourcePath, targetDir });
      // Link existing read-only dependency caches (node_modules) from the source
      // checkout so `tsc` / `npm test` / `vitest` work in clean checkouts without
      // mutating the source repo or polluting git status.
      linkedDeps.push(...linkNodeModules(repo.sourcePath, targetDir));
      boundCommits[repo.name] = repo.headSha;
      if (targetRepos.length === 1 && !step.combo) runCwd = targetDir;
    }

    const result = await runShellCommand(step.command, runCwd, step.timeoutMs ?? 120_000, {
      TIMO_VERIFY_ROOT: isolatedRoot,
      TIMO_VERIFY_COMMITS: JSON.stringify(boundCommits),
    });

    const durationMs = Date.now() - startedAt;
    if (result.timedOut) {
      return {
        stepName,
        stepType: "command_check",
        status: "rejected",
        verifierVersion: "command-check-v1",
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
        boundCommits,
        findings: [{ code: "command_timed_out", detail: `verification command timed out after ${step.timeoutMs ?? 120_000}ms` }],
      };
    }

    if (result.exitCode !== 0) {
      const excerpt = (result.stderr || result.stdout || `exit code ${result.exitCode}`).trim().slice(0, 800);
      return {
        stepName,
        stepType: "command_check",
        status: "rejected",
        verifierVersion: "command-check-v1",
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
        boundCommits,
        findings: [{ code: "command_failed", detail: `${stepName} exited with ${result.exitCode}: ${excerpt}` }],
      };
    }

    return {
      stepName,
      stepType: "command_check",
      status: "accepted",
      verifierVersion: "command-check-v1",
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs,
      boundCommits,
      findings: [],
    };
  } catch (error) {
    return {
      stepName,
      stepType: "command_check",
      status: "rejected",
      verifierVersion: "command-check-v1",
      durationMs: Date.now() - startedAt,
      boundCommits,
      findings: [{ code: "checkout_failed", detail: error instanceof Error ? error.message : String(error) }],
    };
  } finally {
    for (const linkPath of linkedDeps) {
      try {
        if (lstatSync(linkPath).isSymbolicLink()) unlinkSync(linkPath);
      } catch {
        // already removed
      }
    }
    for (const item of checkedOut) {
      context.workspaces.cleanupCheckout(item.sourcePath, item.targetDir);
    }
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

function linkNodeModules(sourceRoot: string, targetRoot: string): string[] {
  const created: string[] = [];
  const tryLink = (src: string, dst: string) => {
    if (!existsSync(src) || existsSync(dst)) return;
    try {
      symlinkSync(src, dst, "dir");
      created.push(dst);
    } catch {
      // ignore permission/symlink errors
    }
  };
  tryLink(join(sourceRoot, "node_modules"), join(targetRoot, "node_modules"));
  // Also link 1-level monorepo/sub-app node_modules (e.g. web/node_modules, packages/*/node_modules)
  for (const container of [".", "packages", "apps"]) {
    const srcParent = container === "." ? sourceRoot : join(sourceRoot, container);
    const dstParent = container === "." ? targetRoot : join(targetRoot, container);
    if (!existsSync(srcParent) || !existsSync(dstParent)) continue;
    try {
      for (const entry of readdirSync(srcParent, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const dstSub = join(dstParent, entry.name);
        if (!existsSync(dstSub)) continue;
        tryLink(join(srcParent, entry.name, "node_modules"), join(dstSub, "node_modules"));
      }
    } catch {
      // ignore unreadable directories
    }
  }
  return created;
}

async function verifyPlatformMr(
  step: Extract<VerificationStep, { type: "platform_mr" }>,
  context: VerificationContext,
): Promise<StepOutcome> {
  if (context.platformVerifier) {
    return context.platformVerifier(step, context);
  }
  return {
    stepName: step.name ?? `platform_mr:${step.repo}`,
    stepType: "platform_mr",
    status: "rejected",
    verifierVersion: "platform-mr-v1",
    findings: [{ code: "platform_verifier_unconfigured", detail: "no platform MR verifier configured" }],
  };
}

async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  extraEnv: Record<string, string>,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = 16_000;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < cap) stdout = (stdout + chunk).slice(0, cap);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < cap) stderr = (stderr + chunk).slice(0, cap);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

/** Formats verification failures into a concise feedback prompt for bounded auto-repair. */
export function formatRepairFeedback(outcome: PipelineOutcome, round: number, maxRounds: number): string {
  const lines = [
    `[Independent Verification Failed — Repair Round ${round}/${maxRounds}]`,
    `Bound commits: ${JSON.stringify(outcome.boundCommits)}`,
  ];
  for (const step of outcome.steps) {
    if (step.status === "accepted") continue;
    lines.push(`- Step "${step.stepName}" (${step.stepType}) => ${step.status} (exit=${step.exitCode ?? "n/a"})`);
    for (const finding of step.findings) {
      lines.push(`  * ${finding.code}: ${finding.detail}`);
    }
    if (step.stderr && step.stderr.trim() !== "") {
      lines.push(`  stderr:\n${step.stderr.trim().slice(-1200)}`);
    } else if (step.stdout && step.stdout.trim() !== "") {
      lines.push(`  stdout:\n${step.stdout.trim().slice(-1200)}`);
    }
  }
  lines.push("Fix the root cause, commit your fix in the repo worktree(s), and ensure all checks pass.");
  return lines.join("\n");
}
