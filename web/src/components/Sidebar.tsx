import type { EfficiencyMetricsSnapshot, ExecutorDescriptor, InboxItem, PolicySnapshot, TaskSummary } from "../api.js";

const STATUS_LABEL: Record<string, string> = {
  accepted: "已接单",
  running: "执行中",
  waiting: "等待中",
  verifying: "验收中",
  stopping: "停止中",
  stopped: "已停止",
  completed: "已完成",
  failed: "失败",
};

export function Sidebar(props: {
  tasks: TaskSummary[];
  inbox: InboxItem[];
  policy: PolicySnapshot | null;
  executors: ExecutorDescriptor[];
  metrics: EfficiencyMetricsSnapshot | null;
  selectedId: string | null;
  onSelect: (taskId: string) => void;
}): React.JSX.Element {
  return (
    <div className="sidebar-scroll">
      <div className="group-label">
        <span>待你决定</span>
        <span className="badge-count mono">{props.inbox.length}</span>
      </div>
      {props.inbox.length === 0 ? (
        <div className="empty-box">暂无待决事项</div>
      ) : (
        <div className="nav-list">
          {props.inbox.map((item) => (
            <button
              key={`${item.taskId}:${item.decisionKey}`}
              type="button"
              className={props.selectedId === item.taskId ? "nav-item active" : "nav-item"}
              onClick={() => props.onSelect(item.taskId)}
            >
              <span className="t">{item.title}</span>
              <span className="s">{item.summary}</span>
            </button>
          ))}
        </div>
      )}

      <div className="group-label">
        <span>全部任务</span>
        <span className="badge-count mono">{props.tasks.length}</span>
      </div>
      {props.tasks.length === 0 ? (
        <div className="empty-box">还没有任务</div>
      ) : (
        <div className="nav-list">
          {props.tasks.map((task) => (
            <button
              key={task.taskId}
              type="button"
              className={props.selectedId === task.taskId ? "nav-item active" : "nav-item"}
              onClick={() => props.onSelect(task.taskId)}
            >
              <span className="t mono">{task.taskId.slice(0, 8)}</span>
              <span className="s">
                {STATUS_LABEL[task.status] ?? task.status}
                {task.waitingReason ? ` · ${task.waitingReason}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="group-label">
        <span>环境与授权</span>
      </div>
      <div className="card">
        <div className="card-body stack small">
          <div className="row">
            <span className={props.policy?.warning ? "dot dot-warning" : "dot dot-success"} />
            <span>策略来源 {props.policy?.source ?? "-"}</span>
          </div>
          <div className="muted mono" style={{ fontSize: 11 }}>
            {props.policy?.summary ?? "not loaded"}
          </div>
          {props.policy?.warning && <div className="muted" style={{ color: "var(--warning)" }}>{props.policy.warning}</div>}
          {props.executors.length > 0 && (
            <div className="stack" style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--border)" }}>
              <div className="muted" style={{ fontSize: 11 }}>已探测执行器</div>
              {props.executors.map((exec) => (
                <div key={exec.id} className="row" style={{ fontSize: 11 }}>
                  <span className={exec.available ? "dot dot-success" : "dot dot-warning"} />
                  <span className="mono">{exec.id}</span>
                  <span className="muted" style={{ marginLeft: "auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 130 }}>
                    {exec.available ? "就绪" : "不可用"}
                  </span>
                </div>
              ))}
            </div>
          )}
          {props.metrics && (
            <div className="stack" style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--border)", fontSize: 11 }}>
              <div className="muted">效率度量（S07）</div>
              <div className="row mono">
                <span className="muted">验收率</span>
                <span style={{ marginLeft: "auto" }}>
                  {props.metrics.verifiedDeliveryRate === null
                    ? "—"
                    : `${Math.round(props.metrics.verifiedDeliveryRate * 100)}% (${props.metrics.verifiedCompletedTasks}/${props.metrics.terminalTasks})`}
                </span>
              </div>
              <div className="row mono">
                <span className="muted">静默放行 / 打断</span>
                <span style={{ marginLeft: "auto" }}>
                  {props.metrics.totalSilentAutoGrants} / {props.metrics.totalHumanInterruptions}
                </span>
              </div>
              <div className="row mono">
                <span className="muted">成本</span>
                <span style={{ marginLeft: "auto" }}>
                  {props.metrics.costStatus === "measured" && props.metrics.costUsd !== null ? `$${props.metrics.costUsd.toFixed(4)}` : "未知（未计量）"}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
