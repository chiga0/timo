import type { InboxItem, Proposal, TaskDetail, TaskEvent } from "../api.js";

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
 * telemetry stays in the live stream tab. The thread is an immutable timeline,
 * so replaying from `afterSeq` renders the same content.
 */
export function Thread(props: {
  detail: TaskDetail | null;
  events: TaskEvent[];
  proposals: Proposal[];
  inbox: InboxItem[];
  connection: "open" | "reconnecting" | "closed";
  tab: "thread" | "live";
  onResolve: (taskId: string, action: string, approved: boolean) => void;
  onConfirmProposal: (proposalId: string) => void;
  onCancelProposal: (proposalId: string) => void;
}): React.JSX.Element {
  const cards = props.events.filter((event) => isAttentionWorthy(event.type));
  const pendingDecision = props.inbox.find((item) => item.taskId === props.detail?.taskId && item.decisionKey === "decision_required");

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
          {props.tab === "live" ? "正在查看该任务的完整归一化事件流" : "注意力防火墙已开启 · 过程噪音不刷屏"}
        </span>
      </div>

      <div className="thread">
        <div className="thread-inner">
          {!props.detail ? (
            <div className="empty-box">在下方输入框交办一件事，或从左侧选择任务</div>
          ) : props.tab === "live" ? (
            <div className="stack">
              <div className="muted small">归一化运行事件流（共 {props.events.length} 条）</div>
              {props.events.length === 0 ? (
                <div className="empty-box">暂无运行事件</div>
              ) : (
                props.events.map((event) => (
                  <article key={event.eventId} className="card">
                    <header className="card-head">
                      <span className="mono">
                        #{event.seq} · {EVENT_LABEL[event.type] ?? event.type} ({event.type})
                      </span>
                      <span className="mono muted small">{new Date(event.createdAt).toLocaleTimeString()}</span>
                    </header>
                    <div className="card-body small">
                      <pre className="card-box mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                        {compact(asRecord(event.payload))}
                      </pre>
                    </div>
                  </article>
                ))
              )}
            </div>
          ) : (
            <>
              {props.proposals.map((proposal) => (
                <article key={proposal.proposalId} className="card">
                  <header className="card-head">
                    <span>变更确认卡 · Amendment Diff</span>
                    <span className="mono muted small">基于 v{proposal.expectedBriefVersion}</span>
                  </header>
                  <div className="card-body stack small">
                    <div className="card-box mono stack">
                      {proposal.change.diff.map((line, index) => (
                        <div key={index}>
                          <div className="muted">- {line.field}: {line.before}</div>
                          <div>+ {line.field}: {line.after}</div>
                        </div>
                      ))}
                    </div>
                    <div className="card-actions" style={{ marginLeft: 0 }}>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => props.onConfirmProposal(proposal.proposalId)}>
                        确认生效
                      </button>
                      <button type="button" className="btn btn-outline-muted btn-sm" onClick={() => props.onCancelProposal(proposal.proposalId)}>
                        取消
                      </button>
                    </div>
                  </div>
                </article>
              ))}

              {cards.length === 0 ? (
                <div className="empty-box">暂无需要关注的事件；过程日志可切至「实时运行流」或右侧检查器查看</div>
              ) : (
                cards.map((event) => (
                  <EventCard
                    key={event.eventId}
                    event={event}
                    detail={props.detail}
                    pendingDecision={pendingDecision}
                    onResolve={props.onResolve}
                  />
                ))
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function EventCard(props: {
  event: TaskEvent;
  detail: TaskDetail | null;
  pendingDecision?: InboxItem;
  onResolve: (taskId: string, action: string, approved: boolean) => void;
}): React.JSX.Element {
  const payload = asRecord(props.event.payload);
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
    const action = typeof payload.action === "string" ? payload.action : props.pendingDecision?.action ?? null;
    const canAct = Boolean(action && props.detail && props.pendingDecision && props.detail.waitingReason === "needs_human_decision");
    return (
      <article className="card">
        <header className="card-head">
          <span>红线审批</span>
          <span className="mono muted small">seq {props.event.seq}</span>
        </header>
        <div className="card-body stack small">
          <div className="card-box mono">{action ?? "-"}</div>
          <div className="muted">{String(payload.reason ?? "")}</div>
          {canAct && action && props.detail ? (
            <div className="card-actions" style={{ marginLeft: 0 }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => props.onResolve(props.detail!.taskId, action, true)}>
                批准并原地恢复
              </button>
              <button type="button" className="btn btn-outline-muted btn-sm" onClick={() => props.onResolve(props.detail!.taskId, action, false)}>
                拒绝
              </button>
            </div>
          ) : (
            <div className="muted">该决策已处理或已关闭</div>
          )}
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
