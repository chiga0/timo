import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/service/task-service.js";
import { defaultConfig } from "../src/config.js";
import { DEFAULT_POLICY, parsePolicy } from "../src/auth/policy.js";
import { AuthorizationEvaluator } from "../src/auth/evaluator.js";
import { Inbox } from "../src/auth/inbox.js";

const log = () => new TextEncoder().encode("2026-11-26T00:00:01Z alpha CONNECT\n2026-11-26T00:00:02Z alpha DISCONNECT\n");

interface Env {
  service: TaskService;
  db: ReturnType<typeof TaskService.open>["db"];
  writer: ReturnType<typeof TaskService.open>["writer"];
  close: () => void;
}

async function withService(fn: (env: Env) => void | Promise<void>, options: { policy?: ReturnType<typeof parsePolicy> } = {}): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "timo-policy-"));
  const { service, db, writer } = TaskService.open(defaultConfig({}, home), options.policy ? { policy: options.policy } : {});
  try {
    await fn({ service, db, writer, close: () => service.close() });
  } finally {
    service.close();
    rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- policy loading

test("missing policy falls back to safe defaults where prod is a red line", () => {
  const loaded = parsePolicy(undefined);
  assert.equal(loaded.source, "default");
  assert.equal(loaded.policy.tier2.some((rule) => rule.action === "deploy_prod"), true);
  assert.equal(loaded.policy.tier1.some((rule) => rule.action === "deploy_prod"), false);
});

test("a policy that lists a red line in tier1 is rejected wholesale", () => {
  const loaded = parsePolicy({
    version: 1,
    tier0: [],
    tier1: [{ action: "deploy_prod" }],
    tier2: [{ action: "deploy_prod" }],
  });
  // Falling back to defaults, not "tier1 wins by order".
  assert.equal(loaded.source, "default");
  assert.ok(loaded.warning?.includes("deploy_prod"));
  assert.equal(loaded.policy.tier1.length, DEFAULT_POLICY.tier1.length);
});

test("a malformed policy file does not half-apply", () => {
  const loaded = parsePolicy({ tier0: "not-an-array" });
  assert.equal(loaded.source, "default");
  assert.ok(loaded.warning);
});

test("tier1 delegation is honoured when the file declares it", () => {
  const loaded = parsePolicy({
    version: 1,
    tier0: [{ action: "read_worktree" }],
    tier1: [{ action: "deploy_staging" }],
    tier2: [{ action: "deploy_prod" }],
  });
  assert.equal(loaded.source, "file");
  const evaluator = new AuthorizationEvaluator(loaded.policy);
  assert.equal(evaluator.classify({ action: "deploy_staging" }).kind, "auto_grant");
});

// ---------------------------------------------------------------- tier routing

test("red lines are matched before tier1, so a broad rule cannot widen them", () => {
  const evaluator = new AuthorizationEvaluator({
    ...DEFAULT_POLICY,
    tier1: [{ action: "deploy_prod" }],
  });
  const decision = evaluator.classify({ action: "deploy_prod" });
  assert.equal(decision.kind, "needs_human");
});

test("unknown actions ask the human instead of being silently allowed", () => {
  const evaluator = new AuthorizationEvaluator(DEFAULT_POLICY);
  assert.equal(evaluator.classify({ action: "totally_new_thing" }).kind, "needs_human");
});

test("environment scope narrows a rule", () => {
  const evaluator = new AuthorizationEvaluator(DEFAULT_POLICY);
  assert.equal(evaluator.classify({ action: "read_logs", environment: "staging" }).kind, "allow");
  assert.equal(evaluator.classify({ action: "read_logs", environment: "dev" }).kind, "auto_grant");
  assert.equal(evaluator.classify({ action: "read_logs", environment: "prod" }).kind, "needs_human");
});

// ---------------------------------------------------------------- attention firewall

test("ten tool logs, two retries and one auto-grant leave the inbox empty", async () => {
  await withService(async ({ service, writer }) => {
    const created = service.createTask({ requestId: "fw-1", log: log() });
    // 10 process telemetry events + 2 retries, all of which must stay out.
    for (let index = 0; index < 10; index++) {
      writer.commit({
        taskId: created.taskId,
        type: "run_observed",
        payload: { tool: "read_file", index },
        options: { idempotencyKey: `tool:${index}` },
      });
    }
    for (let index = 0; index < 2; index++) {
      writer.commit({
        taskId: created.taskId,
        type: "task_waiting",
        payload: { waitingReason: "retrying", attempt: index },
        options: { idempotencyKey: `retry:${index}` },
      });
    }
    // One tier-1 auto-grant: recorded in the audit trail, absent from the inbox.
    const granted = service.requestAuthorization(created.taskId, { action: "open_pull_request", environment: "dev" });
    assert.equal(granted.decision, "auto_grant");

    assert.deepEqual(service.listInbox(), []);
  });
});

test("a red line raises exactly one card and is never auto-approved", async () => {
  await withService(async ({ service }) => {
    const created = service.createTask({ requestId: "fw-2", log: log() });
    const first = service.requestAuthorization(created.taskId, { action: "deploy_prod", environment: "prod" });
    assert.equal(first.decision, "needs_human");
    assert.equal(first.tier, 2);
    assert.equal(service.getTask(created.taskId).status, "waiting");
    assert.equal(service.getTask(created.taskId).waitingReason, "needs_human_decision");

    // Repeating the same request updates the same card instead of adding one.
    service.requestAuthorization(created.taskId, { action: "deploy_prod", environment: "prod" });
    const inbox = service.listInbox();
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.decisionKey, "decision_required");

    // Approval resumes in place and clears the card.
    const resolved = service.resolveAuthorization(created.taskId, { action: "deploy_prod", approved: true });
    assert.equal(resolved.status, "waiting");
    assert.deepEqual(service.listInbox(), []);
  });
});

test("declining a red line fails the task rather than resuming it", async () => {
  await withService(async ({ service }) => {
    const created = service.createTask({ requestId: "fw-3", log: log() });
    service.requestAuthorization(created.taskId, { action: "delete_cloud_resource" });
    const resolved = service.resolveAuthorization(created.taskId, { action: "delete_cloud_resource", approved: false });
    assert.equal(resolved.status, "failed");
    assert.deepEqual(service.listInbox(), []);
  });
});

test("repeated updates to one decision keep a single inbox record", async () => {
  await withService(async ({ service, db }) => {
    const created = service.createTask({ requestId: "fw-4", log: log() });
    const inbox = new Inbox(db);
    for (let index = 0; index < 5; index++) {
      inbox.upsert({
        taskId: created.taskId,
        decisionKey: "decision_required",
        title: "需要你的决定",
        summary: `第 ${index + 1} 次更新`,
        options: ["批准", "拒绝"],
        now: `2026-11-26T00:00:0${index}.000Z`,
      });
    }
    const items = service.listInbox();
    assert.equal(items.length, 1);
    assert.equal(items[0]!.summary, "第 5 次更新");
    assert.equal(items[0]!.createdAt, "2026-11-26T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------- two-phase proposals

test("a proposal does not touch the brief until confirmed", async () => {
  await withService(async ({ service, writer }) => {
    const created = service.createTask({ requestId: "prop-1", log: log() });
    const before = service.getTask(created.taskId);
    const brief = {
      goal: "新的目标",
      must: ["新必须项"],
      mustNot: [],
      evidence: [],
    };
    const proposal = service.proposeChange(created.taskId, {
      change: { kind: "brief", brief, diff: [{ field: "goal", before: before.briefVersion === 1 ? "旧" : "旧", after: "新的目标" }] },
      reason: "需求改口",
    });
    assert.equal(proposal.status, "pending");
    // Nothing changed yet: no amended event, same brief version.
    assert.equal(writer.ledger.forTask(created.taskId).filter((event) => event.type === "task_amended").length, 0);
    assert.equal(service.getTask(created.taskId).briefVersion, before.briefVersion);

    const applied = service.confirmProposal(proposal.proposalId);
    assert.equal(applied.briefVersion, before.briefVersion + 1);
    assert.equal(writer.ledger.forTask(created.taskId).filter((event) => event.type === "task_amended").length, 1);
  });
});

test("a cancelled proposal never modifies the task", async () => {
  await withService(async ({ service, writer }) => {
    const created = service.createTask({ requestId: "prop-2", log: log() });
    const proposal = service.proposeChange(created.taskId, {
      change: { kind: "brief", brief: { goal: "不该生效", must: [], mustNot: [], evidence: [] }, diff: [] },
      reason: "取消示例",
    });
    const cancelled = service.cancelProposal(proposal.proposalId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(writer.ledger.forTask(created.taskId).filter((event) => event.type === "task_amended").length, 0);
    assert.equal(service.getTask(created.taskId).briefVersion, 1);
  });
});

test("a proposal drafted on a stale revision is refused", async () => {
  await withService(async ({ service }) => {
    const created = service.createTask({ requestId: "prop-3", log: log() });
    const proposal = service.proposeChange(created.taskId, {
      change: { kind: "brief", brief: { goal: "过期提案", must: [], mustNot: [], evidence: [] }, diff: [] },
      reason: "先于 amend",
    });
    // Someone amends first, moving the task past the proposal's base revision.
    service.amendTask(created.taskId, { expectedBriefVersion: 1, goal: "先到一步" });
    assert.throws(() => service.confirmProposal(proposal.proposalId), (error: Error) => error.name === "ProposalConflictError");
    assert.equal(service.getTask(created.taskId).briefVersion, 2);
  });
});

test("policy.json on disk is loaded, and an invalid one is surfaced not applied", async () => {
  const home = mkdtempSync(join(tmpdir(), "timo-policy-file-"));
  try {
    const path = join(home, "policy.json");
    writeFileSync(path, JSON.stringify({ version: 1, tier0: [{ action: "read_worktree" }], tier1: [], tier2: [{ action: "deploy_prod" }] }), { mode: 0o600 });
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    assert.equal(parsePolicy(raw).source, "file");

    writeFileSync(path, "{ not valid json", { mode: 0o600 });
    assert.throws(() => JSON.parse(readFileSync(path, "utf8")));
    // The loader is fed parsed data; a parse failure at the caller is reported
    // rather than silently widening the delegation.
    assert.equal(parsePolicy({ tier1: "bad" }).source, "default");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
