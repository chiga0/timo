import type { Database } from "../store/database.js";
import type { TaskStore } from "../store/tasks.js";

/**
 * M4 / S07 Efficiency & Attention-Firewall Metrics (docs/acceptance.md S07,
 * docs/implementation-plan.md Step 6.1).
 *
 * Computed deterministically from Timo's durable SQLite ledger (`tasks`,
 * `task_events`, `authorization_audit`, `verifications`, `executions`,
 * `evidence`). Cost that cannot be queried from a provider is ALWAYS reported
 * explicitly as `unknown_unmetered`, never fabricated as `0`.
 */

export interface TaskEfficiencyMetrics {
  taskId: string;
  kind: string;
  executorId: string | null;
  status: string;
  verifiedCompleted: boolean;
  durationMs: number;
  attemptsUsed: number;
  handoffCount: number;
  generations: number;
  /** Necessary human interruptions (Tier 2 red lines + watchdog blocked escalations). */
  humanInterruptions: number;
  /** Tier 0/1 actions handled autonomously without disturbing the user. */
  silentAutoGrants: number;
  /** First-level 0-Token watchdog signals observed. */
  watchdogSignals: number;
  /** Second-level chief-of-staff automatic recoveries (steer / handoff). */
  watchdogAutoRecovered: number;
  /** Number of process-telemetry items leaked to Inbox (invariant: always 0). */
  inboxTelemetryLeaks: number;
  /** Cost metering discipline: unknown costs are explicitly labelled, never 0. */
  costUsd: number | null;
  costStatus: "measured" | "unknown_unmetered";
}

export interface AggregateEfficiencyMetrics {
  generatedAt: string;
  totalTasks: number;
  terminalTasks: number;
  verifiedCompletedTasks: number;
  failedTasks: number;
  stoppedTasks: number;
  activeTasks: number;
  /** verifiedCompletedTasks / terminalTasks (null when no terminal tasks yet). */
  verifiedDeliveryRate: number | null;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  totalAttemptsUsed: number;
  totalHandoffs: number;
  totalHumanInterruptions: number;
  totalSilentAutoGrants: number;
  totalWatchdogSignals: number;
  totalWatchdogAutoRecovered: number;
  inboxTelemetryLeaks: number;
  costUsd: number | null;
  costStatus: "measured" | "unknown_unmetered";
  tasks: TaskEfficiencyMetrics[];
}

export interface ManualBaselineTrial {
  label: string;
  executorId: string;
  totalTasks: number;
  verifiedCompletedTasks: number;
  avgDurationMs: number;
  humanMinutes: number;
  manualStatusChecks: number;
  repeatedExplanations: number;
  interruptions: number;
  costUsd: number | null;
}

const ALLOWED_INBOX_KEYS = new Set(["decision_required", "delivery_verified", "task_failed"]);

export function computeTaskMetrics(db: Database, store: TaskStore, taskId: string): TaskEfficiencyMetrics | null {
  const view = store.view(taskId);
  if (!view) return null;
  const task = view.task;

  const createdMs = Date.parse(task.createdAt);
  const terminalRow = db
    .prepare(
      `SELECT created_at FROM task_events
       WHERE task_id = ? AND type IN ('task_completed', 'task_failed', 'task_stopped')
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(taskId) as { created_at: string } | undefined;
  const endMs = terminalRow ? Date.parse(terminalRow.created_at) : Date.parse(task.updatedAt);
  const durationMs = Number.isFinite(createdMs) && Number.isFinite(endMs) ? Math.max(0, endMs - createdMs) : 0;

  const genRow = db.prepare("SELECT COUNT(*) AS n FROM executions WHERE task_id = ?").get(taskId) as { n: number };
  const generations = Math.max(1, Number(genRow?.n ?? 1));
  const handoffCount = Math.max(0, generations - 1);

  const attemptsEvidence = store.getEvidence<number>(taskId, "attemptsUsed");
  const attemptsUsed = typeof attemptsEvidence === "number" ? attemptsEvidence : Math.max(view.runs.length, task.runId ? 1 : 0);

  const interruptionsRow = db
    .prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND type = 'decision_required'")
    .get(taskId) as { n: number };
  const humanInterruptions = Number(interruptionsRow?.n ?? 0);

  const autoGrantsRow = db
    .prepare("SELECT COUNT(*) AS n FROM authorization_audit WHERE task_id = ? AND tier IN (0, 1)")
    .get(taskId) as { n: number };
  const silentAutoGrants = Number(autoGrantsRow?.n ?? 0);

  const wdRow = db
    .prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND type = 'watchdog_signal'")
    .get(taskId) as { n: number };
  const watchdogSignals = Number(wdRow?.n ?? 0);

  const steers = store.getEvidence<number>(taskId, "triageSteerCount") ?? 0;
  const triageHandoffs = store.getEvidence<number>(taskId, "triageHandoffCount") ?? 0;
  const watchdogAutoRecovered = steers + triageHandoffs;

  const inboxRows = db.prepare("SELECT decision_key FROM inbox_items WHERE task_id = ?").all(taskId) as Array<{ decision_key: string }>;
  const inboxTelemetryLeaks = inboxRows.filter((row) => !ALLOWED_INBOX_KEYS.has(row.decision_key)).length;

  const verifiedCompleted =
    task.status === "completed" && view.verification !== null && view.verification.result === "accepted" && !view.verification.stale;

  const measuredCost = store.getEvidence<number>(taskId, "measuredCostUsd");
  const hasMeasuredCost = typeof measuredCost === "number" && Number.isFinite(measuredCost);

  return {
    taskId,
    kind: task.kind,
    executorId: task.executorId,
    status: task.status,
    verifiedCompleted,
    durationMs,
    attemptsUsed,
    handoffCount,
    generations,
    humanInterruptions,
    silentAutoGrants,
    watchdogSignals,
    watchdogAutoRecovered,
    inboxTelemetryLeaks,
    costUsd: hasMeasuredCost ? measuredCost : null,
    costStatus: hasMeasuredCost ? "measured" : "unknown_unmetered",
  };
}

export function computeAggregateMetrics(db: Database, store: TaskStore, limit = 200): AggregateEfficiencyMetrics {
  const rows = store.listTasks(limit);
  const tasks: TaskEfficiencyMetrics[] = [];
  for (const row of rows) {
    const m = computeTaskMetrics(db, store, row.taskId);
    if (m) tasks.push(m);
  }

  const terminal = tasks.filter((t) => t.status === "completed" || t.status === "failed" || t.status === "stopped");
  const verifiedCompletedTasks = tasks.filter((t) => t.verifiedCompleted).length;
  const failedTasks = tasks.filter((t) => t.status === "failed").length;
  const stoppedTasks = tasks.filter((t) => t.status === "stopped").length;
  const activeTasks = tasks.length - terminal.length;

  const durations = terminal.map((t) => t.durationMs).sort((a, b) => a - b);
  const avgDurationMs = durations.length > 0 ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length) : null;
  const medianDurationMs =
    durations.length > 0 ? durations[Math.floor(durations.length / 2)]! : null;

  const allMeasured = tasks.length > 0 && tasks.every((t) => t.costStatus === "measured" && t.costUsd !== null);
  const costUsd = allMeasured ? Number(tasks.reduce((sum, t) => sum + (t.costUsd ?? 0), 0).toFixed(4)) : null;

  return {
    generatedAt: new Date().toISOString(),
    totalTasks: tasks.length,
    terminalTasks: terminal.length,
    verifiedCompletedTasks,
    failedTasks,
    stoppedTasks,
    activeTasks,
    verifiedDeliveryRate: terminal.length > 0 ? Number((verifiedCompletedTasks / terminal.length).toFixed(4)) : null,
    avgDurationMs,
    medianDurationMs,
    totalAttemptsUsed: tasks.reduce((sum, t) => sum + t.attemptsUsed, 0),
    totalHandoffs: tasks.reduce((sum, t) => sum + t.handoffCount, 0),
    totalHumanInterruptions: tasks.reduce((sum, t) => sum + t.humanInterruptions, 0),
    totalSilentAutoGrants: tasks.reduce((sum, t) => sum + t.silentAutoGrants, 0),
    totalWatchdogSignals: tasks.reduce((sum, t) => sum + t.watchdogSignals, 0),
    totalWatchdogAutoRecovered: tasks.reduce((sum, t) => sum + t.watchdogAutoRecovered, 0),
    inboxTelemetryLeaks: tasks.reduce((sum, t) => sum + t.inboxTelemetryLeaks, 0),
    costUsd,
    costStatus: allMeasured ? "measured" : "unknown_unmetered",
    tasks,
  };
}

/**
 * Generates an S07 Markdown comparison table between Timo and a manual
 * single-executor baseline under the same tasks and total budget.
 */
export function renderS07ComparisonReport(
  timo: AggregateEfficiencyMetrics,
  timoHuman: { humanMinutes: number; manualStatusChecks: number; repeatedExplanations: number },
  baseline: ManualBaselineTrial,
): string {
  const timoRate = timo.verifiedDeliveryRate === null ? "N/A" : `${(timo.verifiedDeliveryRate * 100).toFixed(1)}%`;
  const baseRate = baseline.totalTasks > 0 ? `${((baseline.verifiedCompletedTasks / baseline.totalTasks) * 100).toFixed(1)}%` : "N/A";
  const timoCost = timo.costStatus === "measured" && timo.costUsd !== null ? `$${timo.costUsd.toFixed(4)}` : "未知（未计量，不记零）";
  const baseCost = baseline.costUsd !== null ? `$${baseline.costUsd.toFixed(4)}` : "未知（未计量，不记零）";

  return [
    `# S07 同预算对照度量报告`,
    ``,
    `- 生成时间：${timo.generatedAt}`,
    `- 对照基线：${baseline.label}（\`${baseline.executorId}\`）`,
    ``,
    `| 指标 | Timo 控制面 | 手工原生终端基线 |`,
    `| --- | --- | --- |`,
    `| 独立验收通过率 | ${timoRate} (${timo.verifiedCompletedTasks}/${timo.terminalTasks}) | ${baseRate} (${baseline.verifiedCompletedTasks}/${baseline.totalTasks}) |`,
    `| 平均端到端耗时 | ${timo.avgDurationMs === null ? "N/A" : `${(timo.avgDurationMs / 1000).toFixed(1)}s`} | ${(baseline.avgDurationMs / 1000).toFixed(1)}s |`,
    `| 人工净投入分钟数 | ${timoHuman.humanMinutes} min | ${baseline.humanMinutes} min |`,
    `| 主动查状态次数 | ${timoHuman.manualStatusChecks} | ${baseline.manualStatusChecks} |`,
    `| 重复解释次数 | ${timoHuman.repeatedExplanations} | ${baseline.repeatedExplanations} |`,
    `| 人工打断次数 | ${timo.totalHumanInterruptions} | ${baseline.interruptions} |`,
    `| 总助理静默放行（Tier 0/1） | ${timo.totalSilentAutoGrants} | 0 |`,
    `| 跨执行器不可变交接次数 | ${timo.totalHandoffs} | 0 |`,
    `| Watchdog 自动恢复 / 信号 | ${timo.totalWatchdogAutoRecovered} / ${timo.totalWatchdogSignals} | N/A |`,
    `| 收件箱过程噪音泄漏 | ${timo.inboxTelemetryLeaks} | N/A |`,
    `| 总成本 | ${timoCost} | ${baseCost} |`,
  ].join("\n");
}
