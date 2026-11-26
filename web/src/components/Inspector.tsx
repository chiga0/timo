import { useState } from "react";
import type { InboxItem, TaskDetail, TaskEvent } from "../api.js";

type Tab = "overview" | "live";

/**
 * Right-hand inspector: a read-only delivery overview plus the live run stream.
 * Destructive actions (stop) require a second confirmation click.
 */
export function Inspector(props: {
  detail: TaskDetail | null;
  events: TaskEvent[];
  inbox: InboxItem[];
  onStop: (taskId: string) => void;
  onAmend: (taskId: string, version: number, goal: string) => void;
  onResolve: (taskId: string, action: string, approved: boolean) => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("overview");
  const [confirmStop, setConfirmStop] = useState(false);
  const [goal, setGoal] = useState("");
  const detail = props.detail;
  const decision = props.inbox.find((item) => item.taskId === detail?.taskId && item.decisionKey === "decision_required");

  if (!detail) {
    return (
      <div className="ins-scroll">
        <div className="ins-head-row">检查器</div>
        <div className="empty-box">选择一个任务查看交付概览</div>
      </div>
    );
  }

  const watchdog = props.events.filter((event) => event.type === "watchdog_signal").at(-1);
  const verifierEvent = props.events.filter((event) => event.type === "verification_recorded").at(-1);

  return (
    <div className="ins-scroll">
      <div className="ins-head-row">
        <span>检查器</span>
        <div className="seg">
          <button type="button" className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>
            交付概览
          </button>
          <button type="button" className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>
            实时运行流
          </button>
        </div>
      </div>

      {tab === "overview" ? (
        <div className="stack">
          {decision && (
            <section className="card">
              <header className="card-head">需要你决定</header>
              <div className="card-body stack small">
                <div>{decision.summary}</div>
                <div className="card-actions" style={{ marginLeft: 0 }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => props.onResolve(detail.taskId, actionOf(decision), true)}
                  >
                    批准
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline-muted btn-sm"
                    onClick={() => props.onResolve(detail.taskId, actionOf(decision), false)}
                  >
                    拒绝
                  </button>
                </div>
              </div>
            </section>
          )}

          <section className="card">
            <header className="card-head">任务</header>
            <div className="card-body">
              <dl className="kv">
                <dt>状态</dt>
                <dd>{detail.status}</dd>
                <dt>等待原因</dt>
                <dd>{detail.waitingReason ?? "—"}</dd>
                <dt>约定版本</dt>
                <dd className="mono">v{detail.briefVersion}</dd>
                <dt>输入摘要</dt>
                <dd className="mono">{detail.inputDigest.slice(0, 16)}…</dd>
                <dt>thread</dt>
                <dd className="mono">{detail.threadId ?? "—"}</dd>
                <dt>run</dt>
                <dd className="mono">{detail.runId ?? "—"}</dd>
              </dl>
            </div>
          </section>

          <section className="card">
            <header className="card-head">看门狗</header>
            <div className="card-body stack small">
              <div className="row">
                <span className={watchdog ? "dot dot-warning" : "dot dot-success"} />
                <span>{watchdog ? `告警：${String((watchdog.payload as Record<string, unknown>).kind ?? "")}` : "健康"}</span>
              </div>
              {watchdog && <div className="muted mono">{String((watchdog.payload as Record<string, unknown>).detail ?? "")}</div>}
            </div>
          </section>

          <section className="card">
            <header className="card-head">验收证据</header>
            <div className="card-body stack small">
              {detail.verification ? (
                <>
                  <div className="row">
                    <span className="dot dot-success" />
                    <span>
                      {detail.verification.result} · {detail.verification.verifierVersion}
                    </span>
                  </div>
                  <div className="muted">{new Date(detail.verification.createdAt).toLocaleString()}</div>
                </>
              ) : (
                <div className="muted">尚无验收记录{verifierEvent ? "" : ""}</div>
              )}
              {detail.result !== null && <pre className="card-box mono" style={{ margin: 0 }}>{JSON.stringify(detail.result, null, 2)}</pre>}
            </div>
          </section>

          <section className="card">
            <header className="card-head">修改约定</header>
            <div className="card-body stack small">
              <input
                className="card-box"
                style={{ border: "1px solid var(--border)" }}
                placeholder="新的目标描述"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={goal.trim() === ""}
                onClick={() => {
                  props.onAmend(detail.taskId, detail.briefVersion, goal.trim());
                  setGoal("");
                }}
              >
                提交新版本（v{detail.briefVersion + 1}）
              </button>
            </div>
          </section>

          <section className="card">
            <header className="card-head">危险操作</header>
            <div className="card-body small">
              {confirmStop ? (
                <div className="row">
                  <span className="muted">确认停止？会作废当前执行代次</span>
                  <div className="card-actions">
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => props.onStop(detail.taskId)}>
                      确认停止
                    </button>
                    <button type="button" className="btn btn-link" onClick={() => setConfirmStop(false)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmStop(true)}>
                  停止任务
                </button>
              )}
            </div>
          </section>
        </div>
      ) : (
        <div className="stack">
          <div className="muted small">归一化事件流（与主对话同一账本，不重复播报）</div>
          <div className="event-log">
            {props.events.length === 0 && <div className="empty-box">暂无事件</div>}
            {props.events.map((event) => (
              <div key={event.eventId} className="event-line">
                <span className="seq mono">{event.seq}</span>
                <span className="mono">{event.type}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function actionOf(item: InboxItem): string {
  const fromSummary = item.summary.match(/^(\w+)\s/)?.[1];
  return fromSummary ?? item.title;
}
