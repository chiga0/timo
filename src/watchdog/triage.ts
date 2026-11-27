import type { TaskStore } from "../store/tasks.js";
import type { TransitionWriter } from "../events/writer.js";
import type { TaskEvent } from "../events/types.js";
import type { WatchdogKind } from "./monitor.js";
import { toIso } from "../util.js";

/**
 * Second-level Chief-of-Staff Watchdog Triage (Step 5.2 / S08).
 *
 * Subscribes to first-level `watchdog_signal` events (which themselves never
 * enter the user's Inbox) and executes bounded autonomous recovery:
 * 1. For `loop` / `scope_drift` / `soft_deadline`: injects a focused corrective
 *    `steer` instruction if the live adapter supports steering and steer budget
 *    remains (ZERO user interruption);
 * 2. If steering is unsupported or already attempted and an alternate ready
 *    executor exists: triggers an immutable `g1 -> g2` handoff;
 * 3. If recovery cannot converge (or budget is exhausted): parks the task in
 *    `waiting(needs_human_decision)` and emits a single structured
 *    `decision_required` (`task_blocked_final`) card with blocker details,
 *    attempted actions, and concrete human choices.
 */

export interface TriageAction {
  taskId: string;
  signalKind: WatchdogKind;
  decision: "steered" | "handoff" | "escalated_blocked" | "ignored";
  detail: string;
}

export interface WatchdogTriageDeps {
  store: TaskStore;
  writer: TransitionWriter;
  steer?: (taskId: string, message: string) => Promise<{ accepted: boolean; runId: string | null; reason?: string }>;
  handoff?: (taskId: string, toExecutor: string, reason: string) => Promise<{ toGeneration: number }>;
  /** Lists currently ready executor ids for optional fallback handoff. */
  availableExecutors?: () => string[];
  /** Maximum automatic steer injections per task before escalating (default 1). */
  maxAutoSteers?: number;
  /** Maximum automatic handoffs per task before escalating (default 1). */
  maxAutoHandoffs?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export class WatchdogTriageEngine {
  private readonly maxAutoSteers: number;
  private readonly maxAutoHandoffs: number;
  private readonly now: () => Date;

  constructor(private readonly deps: WatchdogTriageDeps) {
    this.maxAutoSteers = deps.maxAutoSteers ?? 1;
    this.maxAutoHandoffs = deps.maxAutoHandoffs ?? 1;
    this.now = deps.now ?? (() => new Date());
  }

  /** Handles one committed `watchdog_signal` event. */
  async handleSignal(event: TaskEvent): Promise<TriageAction> {
    if (event.type !== "watchdog_signal") {
      return { taskId: event.taskId, signalKind: "stall", decision: "ignored", detail: "not a watchdog_signal" };
    }
    const payload = (event.payload ?? {}) as { kind?: WatchdogKind; detail?: string };
    const kind: WatchdogKind = payload.kind ?? "stall";
    const detail = payload.detail ?? "watchdog anomaly";
    const task = this.deps.store.get(event.taskId);
    if (!task || task.status === "completed" || task.status === "failed" || task.status === "stopped" || task.status === "stopping") {
      return { taskId: event.taskId, signalKind: kind, decision: "ignored", detail: "task already terminal" };
    }

    const nowIso = toIso(this.now());
    const steerCount = this.deps.store.getEvidence<number>(event.taskId, "triageSteerCount") ?? 0;
    const handoffCount = this.deps.store.getEvidence<number>(event.taskId, "triageHandoffCount") ?? 0;
    const triedActions = this.deps.store.getEvidence<string[]>(event.taskId, "triageTriedActions") ?? [];

    // 1. Try in-place steering for loop / scope_drift / soft_deadline / stall when budget allows.
    if (this.deps.steer && steerCount < this.maxAutoSteers) {
      const instruction = buildSteerInstruction(kind, detail);
      const result = await this.deps.steer(event.taskId, instruction);
      if (result.accepted) {
        this.deps.store.setEvidence(event.taskId, "triageSteerCount", steerCount + 1, nowIso);
        this.deps.store.setEvidence(event.taskId, "triageTriedActions", [...triedActions, `steer(${kind})`], nowIso);
        this.deps.store.setEvidence(event.taskId, "lastTriageAction", { decision: "steered", kind, instruction, at: nowIso }, nowIso);
        this.deps.log?.(`watchdog triage: steered ${event.taskId} for ${kind}`);
        return { taskId: event.taskId, signalKind: kind, decision: "steered", detail: instruction };
      }
    }

    // 2. Try immutable g1->g2 handoff to an alternate ready executor when available.
    if (this.deps.handoff && this.deps.availableExecutors && handoffCount < this.maxAutoHandoffs) {
      const currentExec = task.executorId ?? "";
      const alternate = this.deps.availableExecutors().find((id) => id !== currentExec);
      if (alternate) {
        try {
          const moved = await this.deps.handoff(event.taskId, alternate, `watchdog triage (${kind}): ${detail}`);
          this.deps.store.setEvidence(event.taskId, "triageHandoffCount", handoffCount + 1, nowIso);
          this.deps.store.setEvidence(event.taskId, "triageTriedActions", [...triedActions, `handoff(${currentExec}->${alternate})`], nowIso);
          this.deps.store.setEvidence(event.taskId, "lastTriageAction", { decision: "handoff", kind, toExecutor: alternate, toGeneration: moved.toGeneration, at: nowIso }, nowIso);
          this.deps.log?.(`watchdog triage: handed off ${event.taskId} to ${alternate} (g${moved.toGeneration})`);
          return { taskId: event.taskId, signalKind: kind, decision: "handoff", detail: `switched to ${alternate} (g${moved.toGeneration})` };
        } catch {
          // Fall through to structured human escalation.
        }
      }
    }

    // 3. Cannot converge automatically: escalate ONE structured blocked help card
    //    and park the task so remaining budget is not burned further.
    const summary = `自动会诊无法收敛（${kind}）：${detail}。已尝试：${triedActions.length > 0 ? triedActions.join(" -> ") : "无自动恢复动作"}`;
    const escalationCount = (this.deps.store.getEvidence<number>(event.taskId, "triageEscalations") ?? 0) + 1;
    this.deps.store.setEvidence(event.taskId, "triageEscalations", escalationCount, nowIso);
    this.deps.store.setEvidence(event.taskId, "lastTriageAction", { decision: "escalated_blocked", kind, summary, at: nowIso }, nowIso);

    this.deps.writer.commit({
      taskId: event.taskId,
      type: "decision_required",
      payload: {
        kind: "task_blocked_final",
        action: "resolve_watchdog_block",
        signalKind: kind,
        reason: summary,
        triedActions,
        options: ["人工接管", "换执行器继续", "停止任务"],
      },
      options: {
        idempotencyKey: `triage:blocked:${kind}:${escalationCount}`,
        now: nowIso,
      },
      project: () => {
        this.deps.store.setStatus(event.taskId, "waiting", "needs_human_decision", nowIso);
        this.deps.store.enqueueNotification(event.taskId, "task_blocked_final", { kind, summary, triedActions }, nowIso);
      },
    });
    this.deps.log?.(`watchdog triage: escalated ${event.taskId} (${kind}) to human`);
    return { taskId: event.taskId, signalKind: kind, decision: "escalated_blocked", detail: summary };
  }
}

function buildSteerInstruction(kind: WatchdogKind, detail: string): string {
  switch (kind) {
    case "loop":
      return `[Watchdog 会诊纠偏] 检测到连续重复失败（${detail}）。请立即停止重复相同尝试，改用其他排查思路或缩小改动范围，先定位最小复现再修复。`;
    case "scope_drift":
      return `[Watchdog 会诊纠偏] 检测到改动范围漂移（${detail}）。请回退无关目录修改，严格聚焦任务约定范围。`;
    case "soft_deadline":
      return `[Watchdog 会诊纠偏] 已超过软期限仍未产出候选（${detail}）。请收敛当前改动，提交最小可验证候选并运行验收命令。`;
    case "stall":
    default:
      return `[Watchdog 会诊纠偏] 检测到运行长时间静默（${detail}）。请汇报当前卡点或中断阻塞命令后继续推进。`;
  }
}
