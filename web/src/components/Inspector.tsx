import { useEffect, useRef, useState } from "react";
import type { InboxItem, Proposal, RunStreamEvent, TaskDetail, TaskEvent } from "../api.js";

type Tab = "overview" | "live";

/**
 * Right-hand inspector: a read-only delivery overview (including multi-repo
 * delivery matrix and effect_unknown reconciliation) plus the live NDJSON run
 * stream with manual steering.
 */
export function Inspector(props: {
  detail: TaskDetail | null;
  events: TaskEvent[];
  runIds: string[];
  activeRunId: string | null;
  runEvents: RunStreamEvent[];
  inbox: InboxItem[];
  proposals: Proposal[];
  onSelectRun: (runId: string) => void;
  onSteer: (taskId: string, message: string) => Promise<{ accepted: boolean; reason?: string }>;
  onReconcileOperation: (operationId: string) => void;
  onStop: (taskId: string) => void;
  onProposeGoal: (taskId: string, goal: string) => void;
  onConfirmProposal: (proposalId: string) => void;
  onCancelProposal: (proposalId: string) => void;
  onResolve: (taskId: string, action: string, approved: boolean) => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("overview");
  const [confirmStop, setConfirmStop] = useState(false);
  const [showProof, setShowProof] = useState(false);
  const [goal, setGoal] = useState("");
  const [steerText, setSteerText] = useState("");
  const [steerFeedback, setSteerFeedback] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const detail = props.detail;
  const decision = props.inbox.find((item) => item.taskId === detail?.taskId && item.decisionKey === "decision_required");
  const unknownOps = (detail?.operations ?? []).filter((op) => op.status === "unknown");

  useEffect(() => {
    if (tab === "live" && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [tab, props.runEvents.length]);

  if (!detail) {
    return (
      <div className="ins-scroll">
        <div className="ins-head-row">检查器</div>
        <div className="empty-box">选择一个任务查看交付概览</div>
      </div>
    );
  }

  const watchdog = props.events.filter((event) => event.type === "watchdog_signal").at(-1);
  const isTerminal = detail.status === "completed" || detail.status === "failed" || detail.status === "stopped";
  const decisionAction = decision?.action ?? null;

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
          {decision && decisionAction && (
            <section className="card">
              <header className="card-head">
                <span>需要你决定</span>
                <span className="mono muted small">{decisionAction}</span>
              </header>
              <div className="card-body stack small">
                <div>{decision.summary}</div>
                <div className="card-actions" style={{ marginLeft: 0 }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => props.onResolve(detail.taskId, decisionAction, true)}
                  >
                    批准
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline-muted btn-sm"
                    onClick={() => props.onResolve(detail.taskId, decisionAction, false)}
                  >
                    拒绝
                  </button>
                </div>
              </div>
            </section>
          )}

          {props.proposals.map((proposal) => (
            <section key={proposal.proposalId} className="card">
              <header className="card-head">
                <span>待确认变更 · Diff</span>
                <span className="mono muted small">v{proposal.expectedBriefVersion}</span>
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
            </section>
          ))}

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

          {unknownOps.map((op) => (
            <section key={op.operationId} className="card">
              <header className="card-head">
                <span>外部效果未知 · 对账核查</span>
                <span className="mono muted small">{op.kind}</span>
              </header>
              <div className="card-body stack small">
                <div className="muted">回执丢失，系统已阻止盲目重发。请先向平台核查真实状态：</div>
                <div className="card-box mono">
                  <div>op: {op.operationId}</div>
                  <div>key: {op.operationKey ?? op.clientRequestId}</div>
                  {op.reconciledAt && <div className="muted">上次核查: {new Date(op.reconciledAt).toLocaleTimeString()}</div>}
                </div>
                <button
                  type="button"
                  className="btn btn-outline-muted btn-sm"
                  onClick={() => props.onReconcileOperation(op.operationId)}
                >
                  重新向平台核查
                </button>
              </div>
            </section>
          ))}

          {detail.repos && detail.repos.length > 0 && (
            <section className="card">
              <header className="card-head">
                <span>跨仓交付矩阵</span>
                <span className="mono muted small">
                  {(detail.result as { productionDeployed?: boolean } | null)?.productionDeployed === false ? "生产未发布" : `${detail.repos.length} 仓`}
                </span>
              </header>
              <div className="card-body stack small">
                {detail.repos.map((repo) => (
                  <div key={repo.name} className="card-box stack" style={{ gap: 4 }}>
                    <div className="row">
                      <span className={ciDot(repo.ciStatus)} />
                      <span className="mono">{repo.name}</span>
                      <span className="muted mono" style={{ marginLeft: "auto", fontSize: 11 }}>
                        {repo.baseRef}
                      </span>
                    </div>
                    <div className="muted mono" style={{ fontSize: 11 }}>
                      base {shortSha(repo.baseSha)} → head {shortSha(repo.headSha)}
                    </div>
                    <div className="row mono" style={{ fontSize: 11 }}>
                      <span>MR: {repo.mrId ?? "—"}</span>
                      <span style={{ marginLeft: "auto" }}>CI: {repo.ciStatus ?? "—"}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="card">
            <header className="card-head">
              <span>验收证据</span>
              {detail.result !== null && (
                <button type="button" className="btn btn-link" onClick={() => setShowProof((open) => !open)}>
                  {showProof ? "收起原文" : "展开原文"}
                </button>
              )}
            </header>
            <div className="card-body stack small">
              {detail.verification ? (
                <>
                  <div className="row">
                    <span
                      className={
                        detail.verification.stale
                          ? "dot dot-warning"
                          : detail.verification.result === "accepted"
                            ? "dot dot-success"
                            : "dot dot-warning"
                      }
                    />
                    <span>
                      {detail.verification.result}
                      {detail.verification.stale ? " (stale)" : ""} · {detail.verification.verifierVersion}
                    </span>
                  </div>
                  <div className="muted">{new Date(detail.verification.createdAt).toLocaleString()}</div>
                </>
              ) : (
                <div className="muted">尚无验收记录</div>
              )}
              {detail.result !== null && showProof && (
                <pre className="card-box mono" style={{ margin: 0 }}>
                  {JSON.stringify(detail.result, null, 2)}
                </pre>
              )}
            </div>
          </section>

          {!isTerminal && (
            <section className="card">
              <header className="card-head">起草约定变更（两阶段确认）</header>
              <div className="card-body stack small">
                <input
                  className="card-box"
                  style={{ border: "1px solid var(--border)" }}
                  placeholder="输入新的目标描述，生成 Diff 确认卡"
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-outline-muted btn-sm"
                  disabled={goal.trim() === ""}
                  onClick={() => {
                    props.onProposeGoal(detail.taskId, goal.trim());
                    setGoal("");
                  }}
                >
                  生成 Diff 确认卡（目标 v{detail.briefVersion + 1}）
                </button>
              </div>
            </section>
          )}

          {!isTerminal && (
            <section className="card">
              <header className="card-head">危险操作</header>
              <div className="card-body small">
                {confirmStop ? (
                  <div className="row">
                    <span className="muted">确认停止？会作废当前执行代次</span>
                    <div className="card-actions">
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => {
                          setConfirmStop(false);
                          props.onStop(detail.taskId);
                        }}
                      >
                        确认停止
                      </button>
                      <button type="button" className="btn btn-link" onClick={() => setConfirmStop(false)}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="btn btn-outline-muted btn-sm" onClick={() => setConfirmStop(true)}>
                    停止任务
                  </button>
                )}
              </div>
            </section>
          )}
        </div>
      ) : (
        <div className="stack">
          <div className="row">
            <span className="muted small">
              {props.activeRunId ? `实时运行流 (${props.activeRunId})` : "归一化账本事件（尚无 NDJSON 运行流）"}
            </span>
          </div>
          {props.runIds.length > 1 && (
            <select
              className="card-box mono small"
              style={{ border: "1px solid var(--border)" }}
              value={props.activeRunId ?? ""}
              onChange={(event) => props.onSelectRun(event.target.value)}
            >
              {props.runIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          )}
          <div className="event-log" ref={logRef}>
            {props.activeRunId ? (
              props.runEvents.length === 0 ? (
                <div className="empty-box">等待执行器输出…</div>
              ) : (
                props.runEvents.map((ev) => (
                  <div key={`${ev.runId}:${ev.seq}`} className="event-line" style={{ alignItems: "flex-start" }}>
                    <span className="seq mono">{ev.seq}</span>
                    <span className="mono" style={{ minWidth: 68, opacity: 0.7 }}>{ev.type}</span>
                    <span style={{ wordBreak: "break-word" }}>{ev.summary}</span>
                  </div>
                ))
              )
            ) : props.events.length === 0 ? (
              <div className="empty-box">暂无事件</div>
            ) : (
              props.events.map((event) => (
                <div key={event.eventId} className="event-line">
                  <span className="seq mono">{event.seq}</span>
                  <span className="mono">{event.type}</span>
                </div>
              ))
            )}
          </div>
          {!isTerminal && (
            <section className="card">
              <header className="card-head">人工纠偏（Steer）</header>
              <div className="card-body stack small">
                <input
                  className="card-box"
                  style={{ border: "1px solid var(--border)" }}
                  placeholder="向当前运行注入纠偏指令…"
                  value={steerText}
                  onChange={(event) => setSteerText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing && steerText.trim() !== "") {
                      event.preventDefault();
                      const msg = steerText.trim();
                      setSteerText("");
                      void props.onSteer(detail.taskId, msg).then((res) => {
                        setSteerFeedback(res.accepted ? "纠偏指令已送达当前运行" : `未送达：${res.reason ?? "执行器不支持实时纠偏"}`);
                      });
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-outline-muted btn-sm"
                  disabled={steerText.trim() === ""}
                  onClick={() => {
                    const msg = steerText.trim();
                    setSteerText("");
                    void props.onSteer(detail.taskId, msg).then((res) => {
                      setSteerFeedback(res.accepted ? "纠偏指令已送达当前运行" : `未送达：${res.reason ?? "执行器不支持实时纠偏"}`);
                    });
                  }}
                >
                  发送纠偏指令
                </button>
                {steerFeedback && <div className="muted mono" style={{ fontSize: 11 }}>{steerFeedback}</div>}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : "—";
}

function ciDot(status: string | null | undefined): string {
  if (status === "passed") return "dot dot-success";
  if (status === "failed" || status === "stale") return "dot dot-warning";
  return "dot";
}
