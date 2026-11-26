import type { TaskDetail, TaskEvent } from "../api.js";

const EVENT_LABEL: Record<string, string> = {
  task_created: "已接单",
  dispatch_started: "开始派发",
  run_observed: "观测到运行",
  task_waiting: "进入等待",
  verification_recorded: "记录验收",
  task_completed: "验收通过",
  task_failed: "任务失败",
  task_amended: "约定已更新",
  task_stopping: "请求停止",
  task_stopped: "已停止",
  watchdog_signal: "看门狗告警",
  decision_required: "需要你决定",
};

/**
 * Main conversation column. Only attention-worthy facts become cards: process
 * telemetry stays in the inspector's live tab. The thread is an immutable
 * timeline, so replaying from `afterSeq` renders the same content.
 */
export function Thread(props: {
  detail: TaskDetail | null;
  events: TaskEvent[];
  connection: "open" | "reconnecting" | "closed";
  tab: "thread" | "live";
  onSelect: () => void;
}): React.JSX.Element {
  const cards = props.events.filter((event) => isAttentionWorthy(event.type));

  return (
    <>
      <div className="ctx-bar">
        <span className="ctx-chip">
          <span className={connectionDot(props.connection)} />
          {props.connection === "open" ? "实时已连接" : props.connection === "reconnecting" ? "重连中" : "未连接"}
        </span>
        {props.detail && (
          <span className="ctx-chip mono">
            {props.detail.taskId.slice(0, 8)} · {props.detail.status}
            {props.detail.waitingReason ? ` · ${props.detail.waitingReason}` : ""}
          </span>
        )}
        <span className="muted small" style={{ marginLeft: "auto" }}>
          {props.tab === "live" ? "主对话保持安静，过程详情见右侧检查器" : "只显示需要你知道的事实"}
        </span>
      </div>

      <div className="thread">
        <div className="thread-inner">
          {!props.detail ? (
            <div className="empty-box">在下方输入框交办一件事，或从左侧选择任务</div>
          ) : cards.length === 0 ? (
            <div className="empty-box">暂无需要关注的事件；过程日志见右侧检查器</div>
          ) : (
            cards.map((event) => <EventCard key={event.eventId} event={event} detail={props.detail} />)
          )}
        </div>
      </div>
    </>
  );
}

function EventCard(props: { event: TaskEvent; detail: TaskDetail | null }): React.JSX.Element {
  const payload = (props.event.payload ?? {}) as Record<string, unknown>;
  const label = EVENT_LABEL[props.event.type] ?? props.event.type;

  if (props.event.type === "task_completed") {
    const result = (payload.result ?? props.detail?.result) as Record<string, unknown> | null;
    return (
      <article className="card">
        <header className="card-head">
          <span>交付已验证</span>
          <span className="mono muted small">seq {props.event.seq}</span>
        </header>
        <div className="card-body stack">
          <div className="card-grid2">
            <div className="card-box mono">verdict: {String(result?.verdict ?? "-")}</div>
            <div className="card-box mono">verifier: {String(result?.verifierVersion ?? "-")}</div>
          </div>
          {Array.isArray(result?.incidents) && result.incidents.length > 0 && (
            <div className="card-box mono">
              {(result.incidents as Array<{ connectionId: string; disconnectLine: number; reconnectLine: number | null }>)
                .map((incident) => `${incident.connectionId} 断连@${incident.disconnectLine} → 恢复@${incident.reconnectLine ?? "无"}`)
                .join("；")}
            </div>
          )}
        </div>
      </article>
    );
  }

  if (props.event.type === "decision_required") {
    return (
      <article className="card">
        <header className="card-head">
          <span>红线审批</span>
          <span className="mono muted small">seq {props.event.seq}</span>
        </header>
        <div className="card-body stack small">
          <div className="card-box mono">{String(payload.action ?? "-")}</div>
          <div className="muted">{String(payload.reason ?? "")}</div>
          <div className="muted">批准或拒绝请在右侧检查器「交付概览」中操作</div>
        </div>
      </article>
    );
  }

  return (
    <article className="card">
      <header className="card-head">
        <span>{label}</span>
        <span className="mono muted small">seq {props.event.seq}</span>
      </header>
      <div className="card-body small">
        <div className="muted mono">{compact(payload)}</div>
      </div>
    </article>
  );
}

function isAttentionWorthy(type: string): boolean {
  return type === "task_created" || type === "task_completed" || type === "task_failed" || type === "decision_required" || type === "task_stopped";
}

function compact(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload);
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

function connectionDot(connection: "open" | "reconnecting" | "closed"): string {
  if (connection === "open") return "dot dot-success";
  if (connection === "reconnecting") return "dot dot-warning";
  return "dot dot-error";
}
