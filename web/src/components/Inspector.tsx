import { useEffect, useRef, useState } from "react";
import type { ExecutorDescriptor, InboxItem, Proposal, RunStreamEvent, TaskDetail, TaskEvent } from "../api.js";

export type InspectorTab = "overview" | "live";

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

/**
 * Task-scoped right-hand detail drawer. Houses concise delivery evidence by
 * default and reveals the live NDJSON execution stream + manual steering on demand.
 */
export function Inspector(props: {
  detail: TaskDetail | null;
  events: TaskEvent[];
  executors: ExecutorDescriptor[];
  runIds: string[];
  activeRunId: string | null;
  runEvents: RunStreamEvent[];
  inbox: InboxItem[];
  proposals: Proposal[];
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onClose: () => void;
  onSelectRun: (runId: string) => void;
  onSteer: (taskId: string, message: string) => Promise<{ accepted: boolean; reason?: string }>;
  onHandoff: (taskId: string, executorId: string) => void;
  onReconcileOperation: (operationId: string) => void;
  onResolveOperation: (operationId: string, resolution: "confirmed_absent") => void;
  onStop: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onRenameTask: (taskId: string, title: string) => void;
  onArchiveTask: (taskId: string, archived: boolean) => void;
  onDeleteTask: (taskId: string, force: boolean) => void;
  onProposeGoal: (taskId: string, goal: string) => void;
  onConfirmProposal: (proposalId: string) => void;
  onCancelProposal: (proposalId: string) => void;
  onResolve: (taskId: string, action: string, approved: boolean) => void;
}): React.JSX.Element {
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [showProof, setShowProof] = useState(false);
  const [goal, setGoal] = useState("");
  const [handoffTarget, setHandoffTarget] = useState("");
  const [steerText, setSteerText] = useState("");
  const [steerFeedback, setSteerFeedback] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const detail = props.detail;
  const decision = props.inbox.find((item) => item.taskId === detail?.taskId && item.decisionKey === "decision_required");
  const unknownOps = (detail?.operations ?? []).filter((op) => op.status === "unknown");
  const readyExecutors = props.executors.filter((e) => e.available);

  useEffect(() => {
    setConfirmStop(false);
    setConfirmDelete(false);
    setEditingTitle(false);
  }, [detail?.taskId]);

  useEffect(() => {
    if (props.tab === "live" && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [props.tab, props.runEvents.length]);

  if (!detail) {
    return (
      <div className="ins-scroll">
        <div className="ins-head-row">
          <span>任务详情</span>
          <button type="button" className="icon-btn" title="关闭" onClick={props.onClose}>×</button>
        </div>
        <div className="empty-box">选择一个任务查看详情与实时流</div>
      </div>
    );
  }

  const watchdog = props.events.filter((event) => event.type === "watchdog_signal").at(-1);
  const isTerminal = detail.status === "completed" || detail.status === "failed" || detail.status === "stopped";
  const decisionAction = decision?.action ?? null;

  return (
    <div className="ins-scroll">
      <div className="ins-head-row">
        <span>任务详情</span>
        <div className="row" style={{ gap: 6 }}>
          <div className="seg">
            <button type="button" className={props.tab === "overview" ? "active" : ""} onClick={() => props.onTabChange("overview")}>
              概览
            </button>
            <button type="button" className={props.tab === "live" ? "active" : ""} onClick={() => props.onTabChange("live")}>
              执行记录
            </button>
          </div>
          <button type="button" className="icon-btn" title="收起详情 (])" onClick={props.onClose}>×</button>
        </div>
      </div>

      {props.tab === "overview" ? (
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
                <div className="card-actions" style={{ marginLeft: 0, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn btn-outline-muted btn-sm"
                    onClick={() => props.onReconcileOperation(op.operationId)}
                  >
                    重新向平台核查
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline-muted btn-sm"
                    onClick={() => props.onResolveOperation(op.operationId, "confirmed_absent")}
                  >
                    人工确认不存在（允许重试）
                  </button>
                </div>
              </div>
            </section>
          ))}

          <section className="card">
            <header className="card-head">
              <span>基本状态</span>
              <span className="mono muted small">{detail.taskId.slice(0, 8)}</span>
            </header>
            <div className="card-body stack">
              {editingTitle ? (
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="input"
                    value={titleDraft}
                    maxLength={120}
                    autoFocus
                    placeholder="输入任务标题（留空恢复默认）"
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        setEditingTitle(false);
                        props.onRenameTask(detail.taskId, titleDraft.trim());
                      } else if (event.key === "Escape") {
                        setEditingTitle(false);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      setEditingTitle(false);
                      props.onRenameTask(detail.taskId, titleDraft.trim());
                    }}
                  >
                    保存
                  </button>
                  <button type="button" className="btn-link" onClick={() => setEditingTitle(false)}>
                    取消
                  </button>
                </div>
              ) : (
                <div className="row" style={{ gap: 6 }}>
                  <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {detail.title || detail.taskId.slice(0, 8)}
                  </span>
                  <button
                    type="button"
                    className="btn-link"
                    style={{ marginLeft: "auto", flexShrink: 0 }}
                    onClick={() => {
                      setTitleDraft(detail.title ?? "");
                      setEditingTitle(true);
                    }}
                  >
                    重命名
                  </button>
                </div>
              )}
              <dl className="kv">
                <dt>状态</dt>
                <dd>
                  {STATUS_LABEL[detail.status] ?? detail.status}
                  {detail.archivedAt ? " · 已归档" : ""}
                </dd>
                <dt>执行器</dt>
                <dd className="mono">{detail.executorId ?? "—"}</dd>
                <dt>等待原因</dt>
                <dd>{detail.waitingReason ?? "—"}</dd>
                <dt>约定版本</dt>
                <dd className="mono">v{detail.briefVersion}</dd>
              </dl>
            </div>
          </section>

          {(() => {
            const modifiedRepos = (detail.repos ?? []).filter(
              (repo) => (repo.headSha && repo.baseSha && repo.headSha !== repo.baseSha) || Boolean(repo.mrId),
            );
            if (modifiedRepos.length === 0) return null;
            return (
              <section className="card">
                <header className="card-head">
                  <span>已改动仓库</span>
                  <span className="mono muted small">
                    {(detail.result as { productionDeployed?: boolean } | null)?.productionDeployed === false ? "生产未发布" : `${modifiedRepos.length} 仓`}
                  </span>
                </header>
                <div className="card-body stack small">
                  {modifiedRepos.map((repo) => (
                    <div key={repo.name} className="card-box stack" style={{ gap: 4 }}>
                      <div className="row">
                        <span className={ciDot(repo.ciStatus)} />
                        <span className="mono">{repo.name}</span>
                        <span className="muted mono" style={{ marginLeft: "auto", fontSize: 11 }}>
                          {repo.baseRef}
                        </span>
                      </div>
                      <div className="muted mono" style={{ fontSize: 11 }}>
                        {shortSha(repo.baseSha)} → {shortSha(repo.headSha)}
                      </div>
                      {(repo.mrId || repo.ciStatus) && (
                        <div className="row mono" style={{ fontSize: 11 }}>
                          <span>MR: {repo.mrId ?? "—"}</span>
                          <span style={{ marginLeft: "auto" }}>CI: {repo.ciStatus ?? "—"}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })()}

          {detail.kind !== "assistant_chat" && (
            <section className="card">
              <header className="card-head">
                <span>独立验收</span>
                {detail.result !== null && (
                  <button type="button" className="btn-link" onClick={() => setShowProof((open) => !open)}>
                    {showProof ? "收起原文" : "查看 JSON"}
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
                              : detail.verification.result === "rejected"
                                ? "dot dot-error"
                                : "dot dot-warning"
                        }
                      />
                      <span>
                        {verificationLabel(detail.verification.result)}
                        {detail.verification.stale ? "（已过期）" : ""}
                      </span>
                    </div>
                    {Array.isArray(detail.verification.findings) && detail.verification.findings.length > 0 && (
                      <div className="stack" style={{ gap: 6 }}>
                        {(detail.verification.findings as Array<{ code?: string; detail?: string }>).map((f, idx) => {
                          const raw = (f.detail || f.code || "验收未通过").trim();
                          const firstLine = raw.split(/\r?\n/)[0] ?? raw;
                          const shortSummary = firstLine.length > 96 ? `${firstLine.slice(0, 95)}…` : firstLine;
                          const hasMore = raw.length > shortSummary.length;
                          return (
                            <div key={idx} className="finding-item">
                              <div className="finding-summary">{shortSummary}</div>
                              {hasMore && (
                                <details className="finding-details">
                                  <summary>展开完整错误输出</summary>
                                  <pre className="finding-pre mono">{raw}</pre>
                                </details>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div className="muted" style={{ fontSize: 11 }}>{new Date(detail.verification.createdAt).toLocaleString()}</div>
                  </>
                ) : (
                  <div className="muted">尚无验收记录（代码提交后自动执行）</div>
                )}
                {detail.result !== null && showProof && (
                  <pre className="card-box mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                    {JSON.stringify(detail.result, null, 2)}
                  </pre>
                )}
              </div>
            </section>
          )}

          {confirmStop ? (
            <section className="card">
              <div className="card-body row small">
                <span className="muted">确认停止并作废当前执行？</span>
                <div className="card-actions">
                  <button
                    type="button"
                    className="btn btn-danger-solid btn-sm"
                    onClick={() => {
                      setConfirmStop(false);
                      props.onStop(detail.taskId);
                    }}
                  >
                    确认停止
                  </button>
                  <button type="button" className="btn-link" onClick={() => setConfirmStop(false)}>
                    取消
                  </button>
                </div>
              </div>
            </section>
          ) : confirmDelete ? (
            <section className="card">
              <div className="card-body row small">
                <span className="muted">{!isTerminal ? "任务仍在运行，确认强停并删除？" : "删除后不可恢复，确认删除？"}</span>
                <div className="card-actions">
                  <button
                    type="button"
                    className="btn btn-danger-solid btn-sm"
                    onClick={() => {
                      setConfirmDelete(false);
                      props.onDeleteTask(detail.taskId, !isTerminal);
                    }}
                  >
                    {!isTerminal ? "强停并删除" : "确认删除"}
                  </button>
                  <button type="button" className="btn-link" onClick={() => setConfirmDelete(false)}>
                    取消
                  </button>
                </div>
              </div>
            </section>
          ) : (
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {(detail.status === "failed" || detail.status === "stopped" || detail.status === "waiting") && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => props.onRetry(detail.taskId)}
                >
                  重试任务
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => props.onArchiveTask(detail.taskId, !detail.archivedAt)}
              >
                {detail.archivedAt ? "取消归档" : "归档"}
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => setConfirmDelete(true)}
              >
                删除任务
              </button>
              {!isTerminal && (
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  style={{ marginLeft: "auto" }}
                  onClick={() => setConfirmStop(true)}
                >
                  停止任务
                </button>
              )}
            </div>
          )}

          <details className="ins-more">
            <summary className="ins-more-summary">高级操作与运行元信息</summary>
            <div className="stack" style={{ marginTop: 8 }}>
              <section className="card">
                <header className="card-head">看门狗与运行标识</header>
                <div className="card-body stack small">
                  <div className="row">
                    <span className={watchdog ? "dot dot-warning" : "dot dot-success"} />
                    <span>{watchdog ? `告警：${String((watchdog.payload as Record<string, unknown>).kind ?? "")}` : "看门狗健康"}</span>
                  </div>
                  {watchdog && <div className="muted mono">{String((watchdog.payload as Record<string, unknown>).detail ?? "")}</div>}
                  <dl className="kv">
                    <dt>输入摘要</dt>
                    <dd className="mono">{detail.inputDigest.slice(0, 16)}…</dd>
                    <dt>thread</dt>
                    <dd className="mono">{detail.threadId ?? "—"}</dd>
                    <dt>run</dt>
                    <dd className="mono">{detail.runId ?? "—"}</dd>
                  </dl>
                </div>
              </section>

              {!isTerminal && (
                <section className="card">
                  <header className="card-head">起草约定变更（两阶段确认）</header>
                  <div className="card-body stack small">
                    <input
                      className="input"
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
                      生成 Diff（v{detail.briefVersion + 1}）
                    </button>
                  </div>
                </section>
              )}

              {!isTerminal && detail.kind === "repo_delivery" && readyExecutors.length > 0 && (
                <section className="card">
                  <header className="card-head">
                    <span>切换执行器交接</span>
                    <span className="mono muted small">{detail.executorId ?? "—"}</span>
                  </header>
                  <div className="card-body stack small">
                    <select
                      aria-label="目标执行器"
                      className="input mono"
                      value={handoffTarget || readyExecutors.find((e) => e.id !== detail.executorId)?.id || readyExecutors[0]!.id}
                      onChange={(event) => setHandoffTarget(event.target.value)}
                    >
                      {readyExecutors.map((exec) => (
                        <option key={exec.id} value={exec.id}>
                          {exec.id}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-outline-muted btn-sm"
                      onClick={() => {
                        const target = handoffTarget || readyExecutors.find((e) => e.id !== detail.executorId)?.id || readyExecutors[0]!.id;
                        props.onHandoff(detail.taskId, target);
                      }}
                    >
                      作废旧代次并交接（g1 → g2）
                    </button>
                  </div>
                </section>
              )}
            </div>
          </details>
        </div>
      ) : (
        <div className="stack">
          <div className="row">
            <span className="muted small">
              {props.activeRunId ? `运行 ${props.activeRunId}` : "尚无运行输出"}
            </span>
          </div>
          {props.runIds.length > 1 && (
            <select
              className="input mono"
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
                    <span className="mono" style={{ minWidth: 64, opacity: 0.7 }}>{ev.type}</span>
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
                  className="input"
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

function verificationLabel(result: string): string {
  if (result === "accepted") return "已通过独立验收";
  if (result === "rejected") return "未通过独立验收";
  if (result === "incomplete") return "输入信息不完整";
  if (result === "waiting_external") return "等待外部 CI";
  return result;
}

function ciDot(status: string | null | undefined): string {
  if (status === "passed") return "dot dot-success";
  if (status === "failed" || status === "stale") return "dot dot-warning";
  return "dot";
}
