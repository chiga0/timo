import { execFileSync } from "node:child_process";

/**
 * External platform abstraction for controlled gateway tools (Step 4.2):
 * - read-only log queries (with redaction & size capping);
 * - MR/PR creation and lookup by stable operation key (`Intent-Before-Effect`);
 * - 0-Token CI status polling bound to exact MR ID & candidate head SHA.
 */

export interface LogQuery {
  environment: string;
  service?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface LogQueryResult {
  lines: string[];
  truncated: boolean;
}

export interface CreateMrInput {
  repo: string;
  branch: string;
  baseRef: string;
  headSha: string;
  title: string;
  body: string;
  clientRequestId: string;
}

export interface MrReceipt {
  mrId: string;
  repo: string;
  url: string;
  branch: string;
  baseRef: string;
  headSha: string;
  clientRequestId: string;
}

export interface CiCheck {
  name: string;
  status: "queued" | "in_progress" | "passed" | "failed";
}

export interface CiStatusResult {
  repo: string;
  mrId: string;
  /** The commit SHA that this CI report was actually evaluated on. */
  headSha: string;
  status: "pending" | "passed" | "failed";
  checks: CiCheck[];
}

/** Raised when the platform call timed out or dropped its ACK after possibly creating an external effect. */
export class PlatformEffectUnknownError extends Error {
  override readonly name = "PlatformEffectUnknownError";
  constructor(message: string) {
    super(message);
  }
}

/** Raised when the platform rejected a request before creating an external effect. */
export class PlatformRejectedError extends Error {
  override readonly name = "PlatformRejectedError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PlatformAdapter {
  readLogs(query: LogQuery, credentials?: Record<string, string | undefined>): Promise<LogQueryResult>;
  createOrUpdateMr(input: CreateMrInput, credentials?: Record<string, string | undefined>): Promise<MrReceipt>;
  /** Looks up an existing MR by stable idempotency key for `effect_unknown` reconciliation. */
  findMrByOperationKey(repo: string, clientRequestId: string, credentials?: Record<string, string | undefined>): Promise<MrReceipt | null>;
  getCiStatus(input: { repo: string; mrId: string; expectedHeadSha: string }, credentials?: Record<string, string | undefined>): Promise<CiStatusResult>;
}

const SECRET_REDACT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/ghp_[A-Za-z0-9]{12,}/g, "[REDACTED_GH_TOKEN]"],
  [/github_pat_[A-Za-z0-9_]{12,}/g, "[REDACTED_GH_PAT]"],
  [/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]"],
  [/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [REDACTED]"],
  [/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
];

/** Redacts secret tokens/passwords from log lines before returning them to a Worker. */
export function redactLogText(text: string): { text: string; redacted: boolean } {
  let out = text;
  let redacted = false;
  for (const [pattern, replacement] of SECRET_REDACT_PATTERNS) {
    const next = out.replace(pattern, replacement);
    if (next !== out) {
      redacted = true;
      out = next;
    }
  }
  return { text: out, redacted };
}

/**
 * Deterministic in-memory platform for S01 / S05 / S06 fixture tests and fault
 * injection (lost ACK, partial dual-MR failure, stale CI SHA, pending->passed transitions).
 */
export class FakePlatformAdapter implements PlatformAdapter {
  readonly logs = new Map<string, string[]>();
  readonly mrs = new Map<string, MrReceipt>();
  readonly ci = new Map<string, CiStatusResult>();
  readonly stats = {
    logQueries: 0,
    mrCalls: 0,
    mrCreated: 0,
    ciPolls: 0,
  };

  /** Optional per-repo scripted faults. */
  readonly faults = {
    /** Fail next MR call for `repo` before external effect (deterministic error). */
    failOnceForRepo: new Set<string>(),
    /** Create the MR on platform, then throw `PlatformEffectUnknownError` (dropped ACK!). */
    dropAckOnceForRepo: new Set<string>(),
    /** Throw `PlatformEffectUnknownError` WITHOUT creating the MR (unconfirmable unknown!). */
    dropAckWithoutCreateForRepo: new Set<string>(),
  };

  private nextMrNumber = 100;

  seedLogs(environment: string, lines: string[]): void {
    this.logs.set(environment, [...lines]);
  }

  setCiStatus(repo: string, mrId: string, result: Omit<CiStatusResult, "repo" | "mrId">): void {
    this.ci.set(`${repo}:${mrId}`, { repo, mrId, ...result });
  }

  async readLogs(query: LogQuery): Promise<LogQueryResult> {
    this.stats.logQueries += 1;
    const all = this.logs.get(query.environment) ?? [];
    const limit = Math.max(1, Math.min(query.limit ?? 100, 500));
    return {
      lines: all.slice(0, limit),
      truncated: all.length > limit,
    };
  }

  async createOrUpdateMr(input: CreateMrInput): Promise<MrReceipt> {
    this.stats.mrCalls += 1;

    if (this.faults.failOnceForRepo.has(input.repo)) {
      this.faults.failOnceForRepo.delete(input.repo);
      throw new PlatformRejectedError("platform_503", `transient platform rejection for ${input.repo}`);
    }

    if (this.faults.dropAckWithoutCreateForRepo.has(input.repo)) {
      this.faults.dropAckWithoutCreateForRepo.delete(input.repo);
      throw new PlatformEffectUnknownError(`connection reset while creating MR for ${input.repo} (outcome unknown)`);
    }

    // Check idempotency key on platform side (real idempotent platform behavior).
    for (const existing of this.mrs.values()) {
      if (existing.repo === input.repo && existing.clientRequestId === input.clientRequestId) {
        existing.headSha = input.headSha;
        return { ...existing };
      }
    }

    this.nextMrNumber += 1;
    const mrId = `mr-${this.nextMrNumber}`;
    const receipt: MrReceipt = {
      mrId,
      repo: input.repo,
      url: `https://git.example.invalid/${input.repo}/merge_requests/${this.nextMrNumber}`,
      branch: input.branch,
      baseRef: input.baseRef,
      headSha: input.headSha,
      clientRequestId: input.clientRequestId,
    };
    this.mrs.set(`${input.repo}:${mrId}`, receipt);
    this.stats.mrCreated += 1;

    if (this.faults.dropAckOnceForRepo.has(input.repo)) {
      this.faults.dropAckOnceForRepo.delete(input.repo);
      throw new PlatformEffectUnknownError(`ACK lost after MR created on platform for ${input.repo}`);
    }

    return { ...receipt };
  }

  async findMrByOperationKey(repo: string, clientRequestId: string): Promise<MrReceipt | null> {
    for (const receipt of this.mrs.values()) {
      if (receipt.repo === repo && receipt.clientRequestId === clientRequestId) {
        return { ...receipt };
      }
    }
    return null;
  }

  async getCiStatus(input: { repo: string; mrId: string; expectedHeadSha: string }): Promise<CiStatusResult> {
    this.stats.ciPolls += 1;
    const stored = this.ci.get(`${input.repo}:${input.mrId}`);
    if (!stored) {
      return {
        repo: input.repo,
        mrId: input.mrId,
        headSha: input.expectedHeadSha,
        status: "pending",
        checks: [{ name: "ci", status: "queued" }],
      };
    }
    return { ...stored, checks: stored.checks.map((c) => ({ ...c })) };
  }
}

/**
 * Real GitHub CLI (`gh`) platform adapter. Credentials are supplied only inside
 * the gateway process environment (never exposed to Worker subprocesses).
 */
export class GhPlatformAdapter implements PlatformAdapter {
  constructor(private readonly options: { ghCommand?: string; cwd?: string } = {}) {}

  async readLogs(): Promise<LogQueryResult> {
    throw new PlatformRejectedError("unsupported", "gh adapter does not provide staging/prod application log reads");
  }

  async createOrUpdateMr(input: CreateMrInput, credentials?: Record<string, string | undefined>): Promise<MrReceipt> {
    const gh = this.options.ghCommand ?? "gh";
    const env = { ...process.env, ...(credentials ?? {}) };
    const marker = `<!-- timo-op:${input.clientRequestId} -->`;
    const existing = await this.findMrByOperationKey(input.repo, input.clientRequestId, credentials);
    if (existing) {
      return { ...existing, headSha: input.headSha };
    }
    try {
      const url = execFileSync(
        gh,
        [
          "pr",
          "create",
          "--repo",
          input.repo,
          "--base",
          input.baseRef,
          "--head",
          input.branch,
          "--title",
          input.title,
          "--body",
          `${input.body}\n\n${marker}`,
        ],
        { cwd: this.options.cwd, encoding: "utf8", env, timeout: 30_000 },
      ).trim();
      const mrId = url.split("/").at(-1) ?? url;
      return {
        mrId,
        repo: input.repo,
        url,
        branch: input.branch,
        baseRef: input.baseRef,
        headSha: input.headSha,
        clientRequestId: input.clientRequestId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ETIMEDOUT|ECONNRESET|socket hang up|timed out/i.test(message)) {
        throw new PlatformEffectUnknownError(message);
      }
      throw new PlatformRejectedError("gh_pr_failed", message);
    }
  }

  async findMrByOperationKey(repo: string, clientRequestId: string, credentials?: Record<string, string | undefined>): Promise<MrReceipt | null> {
    const gh = this.options.ghCommand ?? "gh";
    const env = { ...process.env, ...(credentials ?? {}) };
    try {
      const raw = execFileSync(
        gh,
        ["pr", "list", "--repo", repo, "--search", `timo-op:${clientRequestId} in:body`, "--json", "number,url,headRefName,baseRefName,headRefOid"],
        { cwd: this.options.cwd, encoding: "utf8", env, timeout: 15_000 },
      );
      const list = JSON.parse(raw) as Array<{ number: number; url: string; headRefName: string; baseRefName: string; headRefOid: string }>;
      const first = list[0];
      if (!first) return null;
      return {
        mrId: String(first.number),
        repo,
        url: first.url,
        branch: first.headRefName,
        baseRef: first.baseRefName,
        headSha: first.headRefOid,
        clientRequestId,
      };
    } catch {
      return null;
    }
  }

  async getCiStatus(
    input: { repo: string; mrId: string; expectedHeadSha: string },
    credentials?: Record<string, string | undefined>,
  ): Promise<CiStatusResult> {
    const gh = this.options.ghCommand ?? "gh";
    const env = { ...process.env, ...(credentials ?? {}) };
    const raw = execFileSync(
      gh,
      ["pr", "view", input.mrId, "--repo", input.repo, "--json", "headRefOid,statusCheckRollup"],
      { cwd: this.options.cwd, encoding: "utf8", env, timeout: 15_000 },
    );
    const parsed = JSON.parse(raw) as { headRefOid: string; statusCheckRollup?: Array<{ name?: string; status?: string; conclusion?: string }> };
    const rollup = parsed.statusCheckRollup ?? [];
    const checks: CiCheck[] = rollup.map((item) => {
      const conclusion = (item.conclusion ?? "").toUpperCase();
      const status = (item.status ?? "").toUpperCase();
      if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
        return { name: item.name ?? "check", status: "passed" };
      }
      if (conclusion === "FAILURE" || conclusion === "TIMED_OUT" || conclusion === "CANCELLED" || conclusion === "ACTION_REQUIRED") {
        return { name: item.name ?? "check", status: "failed" };
      }
      return { name: item.name ?? "check", status: status === "IN_PROGRESS" ? "in_progress" : "queued" };
    });
    const overall: CiStatusResult["status"] = checks.some((c) => c.status === "failed")
      ? "failed"
      : checks.length > 0 && checks.every((c) => c.status === "passed")
        ? "passed"
        : "pending";
    return { repo: input.repo, mrId: input.mrId, headSha: parsed.headRefOid, status: overall, checks };
  }
}

export interface EnterpriseGitOptions {
  baseUrl: string;
  /** REST API path prefix, e.g. `/api/v4` or `/api/v3` (default `/api/v4`). */
  apiPath?: string;
  /** Header carrying the private token, e.g. `PRIVATE-TOKEN` or `Authorization`. */
  authHeader?: string;
  /** Logical key inside `credentials`, e.g. `ENTERPRISE_GIT_TOKEN`. */
  credentialKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Generic Enterprise Git / GitLab-compatible REST platform adapter (works with
 * self-hosted GitLab and internal enterprise Git platforms speaking standard
 * Git protocol + v3/v4 REST APIs). Credentials remain strictly inside the
 * gateway process and are never leaked to Worker subprocesses.
 */
export class EnterpriseGitPlatformAdapter implements PlatformAdapter {
  private readonly baseUrl: string;
  private readonly apiPath: string;
  private readonly authHeader: string;
  private readonly credentialKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EnterpriseGitOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiPath = (options.apiPath ?? "/api/v4").replace(/\/+$/, "");
    this.authHeader = options.authHeader ?? "PRIVATE-TOKEN";
    this.credentialKey = options.credentialKey ?? "ENTERPRISE_GIT_TOKEN";
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headersFor(credentials?: Record<string, string | undefined>): Record<string, string> {
    const token =
      credentials?.[this.credentialKey] ??
      credentials?.ENTERPRISE_GIT_TOKEN ??
      credentials?.GITLAB_TOKEN;
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (token) {
      headers[this.authHeader] =
        this.authHeader.toLowerCase() === "authorization" && !/^Bearer\s+/i.test(token) ? `Bearer ${token}` : token;
    }
    return headers;
  }

  private async requestJson<T>(
    method: string,
    path: string,
    credentials?: Record<string, string | undefined>,
    body?: unknown,
    treatTimeoutAsUnknown = false,
  ): Promise<T> {
    const url = `${this.baseUrl}${this.apiPath}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: this.headersFor(credentials),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new PlatformRejectedError(
          `enterprise_git_${response.status}`,
          `${method} ${path} failed (${response.status}): ${text.slice(0, 240)}`,
        );
      }
      return (text === "" ? {} : JSON.parse(text)) as T;
    } catch (error) {
      if (error instanceof PlatformRejectedError || error instanceof PlatformEffectUnknownError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (treatTimeoutAsUnknown || /abort|ETIMEDOUT|ECONNRESET|socket hang up|timed out|fetch failed/i.test(message)) {
        throw new PlatformEffectUnknownError(message);
      }
      throw new PlatformRejectedError("enterprise_git_network", message);
    } finally {
      clearTimeout(timer);
    }
  }

  async readLogs(): Promise<LogQueryResult> {
    throw new PlatformRejectedError("unsupported", "enterprise git adapter does not provide application log reads");
  }

  async createOrUpdateMr(input: CreateMrInput, credentials?: Record<string, string | undefined>): Promise<MrReceipt> {
    const existing = await this.findMrByOperationKey(input.repo, input.clientRequestId, credentials);
    if (existing) {
      return { ...existing, headSha: input.headSha };
    }
    const encoded = encodeURIComponent(input.repo);
    const marker = `<!-- timo-op:${input.clientRequestId} -->`;
    const created = await this.requestJson<{
      iid?: number;
      id?: number;
      web_url?: string;
      source_branch?: string;
      target_branch?: string;
      sha?: string;
    }>(
      "POST",
      `/projects/${encoded}/merge_requests`,
      credentials,
      {
        source_branch: input.branch,
        target_branch: input.baseRef,
        title: input.title,
        description: `${input.body}\n\n${marker}`,
      },
      true,
    );
    const mrId = String(created.iid ?? created.id ?? "");
    return {
      mrId: mrId || input.branch,
      repo: input.repo,
      url: created.web_url ?? `${this.baseUrl}/${input.repo}/merge_requests/${mrId}`,
      branch: created.source_branch ?? input.branch,
      baseRef: created.target_branch ?? input.baseRef,
      headSha: created.sha ?? input.headSha,
      clientRequestId: input.clientRequestId,
    };
  }

  async findMrByOperationKey(
    repo: string,
    clientRequestId: string,
    credentials?: Record<string, string | undefined>,
  ): Promise<MrReceipt | null> {
    const encoded = encodeURIComponent(repo);
    const marker = `timo-op:${clientRequestId}`;
    try {
      const list = await this.requestJson<
        Array<{ iid?: number; id?: number; web_url?: string; source_branch?: string; target_branch?: string; sha?: string; description?: string }>
      >("GET", `/projects/${encoded}/merge_requests?state=opened&search=${encodeURIComponent(marker)}`, credentials);
      const match = (Array.isArray(list) ? list : []).find((mr) => (mr.description ?? "").includes(marker));
      if (!match) return null;
      const mrId = String(match.iid ?? match.id ?? "");
      return {
        mrId,
        repo,
        url: match.web_url ?? `${this.baseUrl}/${repo}/merge_requests/${mrId}`,
        branch: match.source_branch ?? "",
        baseRef: match.target_branch ?? "",
        headSha: match.sha ?? "",
        clientRequestId,
      };
    } catch {
      return null;
    }
  }

  async getCiStatus(
    input: { repo: string; mrId: string; expectedHeadSha: string },
    credentials?: Record<string, string | undefined>,
  ): Promise<CiStatusResult> {
    const encoded = encodeURIComponent(input.repo);
    const mr = await this.requestJson<{
      sha?: string;
      head_pipeline?: { status?: string };
      pipeline?: { status?: string };
    }>("GET", `/projects/${encoded}/merge_requests/${encodeURIComponent(input.mrId)}`, credentials);
    const headSha = mr.sha || input.expectedHeadSha;
    let statuses: Array<{ name?: string; status?: string }> = [];
    try {
      const rawStatuses = await this.requestJson<Array<{ name?: string; status?: string }>>(
        "GET",
        `/projects/${encoded}/repository/commits/${encodeURIComponent(headSha)}/statuses`,
        credentials,
      );
      if (Array.isArray(rawStatuses)) statuses = rawStatuses;
    } catch {
      // Some enterprise Git instances only expose pipeline status on the MR object.
    }

    const mapStatus = (raw?: string): CiCheck["status"] => {
      const s = (raw ?? "").toLowerCase();
      if (s === "success" || s === "passed" || s === "skipped") return "passed";
      if (s === "failed" || s === "canceled" || s === "cancelled") return "failed";
      if (s === "running") return "in_progress";
      return "queued";
    };

    const checks: CiCheck[] =
      statuses.length > 0
        ? statuses.map((item) => ({ name: item.name ?? "ci", status: mapStatus(item.status) }))
        : mr.head_pipeline?.status || mr.pipeline?.status
          ? [{ name: "pipeline", status: mapStatus(mr.head_pipeline?.status ?? mr.pipeline?.status) }]
          : [];

    const overall: CiStatusResult["status"] = checks.some((c) => c.status === "failed")
      ? "failed"
      : checks.length > 0 && checks.every((c) => c.status === "passed")
        ? "passed"
        : "pending";
    return { repo: input.repo, mrId: input.mrId, headSha, status: overall, checks };
  }

  /** Lightweight connectivity probe for the Settings UI (never returns secrets). */
  async testConnection(credentials?: Record<string, string | undefined>): Promise<{ ok: boolean; status?: number; message: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 8_000));
    timer.unref?.();
    try {
      const probeUrl = `${this.baseUrl}${this.apiPath}/user`;
      const res = await this.fetchImpl(probeUrl, { method: "GET", headers: this.headersFor(credentials), signal: controller.signal });
      if (res.ok) return { ok: true, status: res.status, message: `连接正常（HTTP ${res.status}）` };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, message: `可达但认证失败（HTTP ${res.status}），请检查凭证 ${this.credentialKey}` };
      }
      // Fallback: check root URL reachability for platforms with custom API paths.
      const rootRes = await this.fetchImpl(this.baseUrl, { method: "HEAD", signal: controller.signal });
      return {
        ok: rootRes.status < 500,
        status: rootRes.status,
        message: `主机可达（HTTP ${rootRes.status}），API ${this.apiPath}/user 返回 ${res.status}`,
      };
    } catch (error) {
      return { ok: false, message: `连接失败：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Dynamic platform router that selects the matching `EnterpriseGitPlatformAdapter`
 * or `GhPlatformAdapter` per repository according to live `TimoUserSettings`.
 */
export class DynamicPlatformAdapter implements PlatformAdapter {
  private readonly github = new GhPlatformAdapter();

  constructor(
    private readonly resolvePlatformForRepo: (repo: string) => PlatformAdapter | null,
  ) {}

  private pick(repo: string): PlatformAdapter {
    return this.resolvePlatformForRepo(repo) ?? this.github;
  }

  readLogs(_query: LogQuery, _credentials?: Record<string, string | undefined>): Promise<LogQueryResult> {
    return this.github.readLogs();
  }

  createOrUpdateMr(input: CreateMrInput, credentials?: Record<string, string | undefined>): Promise<MrReceipt> {
    return this.pick(input.repo).createOrUpdateMr(input, credentials);
  }

  findMrByOperationKey(repo: string, clientRequestId: string, credentials?: Record<string, string | undefined>): Promise<MrReceipt | null> {
    return this.pick(repo).findMrByOperationKey(repo, clientRequestId, credentials);
  }

  getCiStatus(
    input: { repo: string; mrId: string; expectedHeadSha: string },
    credentials?: Record<string, string | undefined>,
  ): Promise<CiStatusResult> {
    return this.pick(input.repo).getCiStatus(input, credentials);
  }
}
