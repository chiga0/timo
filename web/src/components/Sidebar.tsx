import type { InboxItem, PolicySnapshot, TaskSummary } from "../api.js";

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
        </div>
      </div>
    </div>
  );
}
