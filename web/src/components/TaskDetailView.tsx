import { useEffect, useRef, useState } from "react";
import type { ExecutorDescriptor, InboxItem, Proposal, RunStreamEvent, TaskDetail, TaskEvent } from "../api.js";
import { AgentLogo, agentLabel } from "./AgentIcons.js";
import { TaskTimeline, type LocalSteerItem } from "./TaskTimeline.js";
import { ScrollToBottomButton, useAutoScroll } from "./ScrollNav.js";
import { useImeGuard } from "./ime.js";

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
 * Full-width task-centric detail page (entered via Task Card "查看详情 →" or
 * clicking a task in the left sidebar). Replaces the cramped 340px right drawer
 * with a clean two-column workspace:
 * - Main column: priority banners, unclipped GFM/Mermaid final conclusion, live
 *   execution stream timeline, and in-flight steering input.
 * - Side rail: original request, modified repos/MR/CI, independent verification
 *   evidence (collapsible stderr/JSON), and advanced controls (handoff/propose).
 */
export function TaskDetailView(props: {
  detail: TaskDetail | null;
  events: TaskEvent[];
  executors: ExecutorDescriptor[];
  runIds: string[];
  activeRunId: string | null;
  runEvents: RunStreamEvent[];
  inbox: InboxItem[];
  proposals: Proposal[];
  onBack: () => void;
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
  onDismissInbox: (taskId: string, decisionKey: string) => void;
}): React.JSX.Element {
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [showProof, setShowProof] = useState(false);
  const [copiedConclusion, setCopiedConclusion] = useState(false);
  const [goal, setGoal] = useState("");
  const [handoffTarget, setHandoffTarget] = useState("");
  const [steerText, setSteerText] = useState("");
  const [localSteers, setLocalSteers] = useState<LocalSteerItem[]>([]);
  const [showRawLog, setShowRawLog] = useState(false);
  const [railReqExpanded, setRailReqExpanded] = useState(false);
  const pageScrollRef = useRef<HTMLDivElement | null>(null);
  const pageInnerRef = useRef<HTMLDivElement | null>(null);
  const rawLogRef = useRef<HTMLDivElement | null>(null);
  const ime = useImeGuard();

  const detail = props.detail;
  const decision = props.inbox.find((item) => item.taskId === detail?.taskId && item.decisionKey === "decision_required");
  const blocked = props.inbox.find((item) => item.taskId === detail?.taskId && item.decisionKey === "task_blocked_final");
  const unknownOps = (detail?.operations ?? []).filter((op) => op.status === "unknown");
  const readyExecutors = props.executors.filter((e) => e.available);

  useEffect(() => {
    setConfirmStop(false);
    setConfirmDelete(false);
    setEditingTitle(false);
    setShowProof(false);
    setLocalSteers([]);
    setShowRawLog(false);
    setRailReqExpanded(false);
  }, [detail?.taskId]);

  // Auto-scroll task detail timeline to bottom when opening/switching task or run, and while live events stream.
  const assistantLen =
    detail?.result && typeof detail.result === "object" && typeof (detail.result as { assistantText?: unknown }).assistantText === "string"
      ? (detail.result as { assistantText: string }).assistantText.length
      : 0;
  const pageScroll = useAutoScroll({
    scrollRef: pageScrollRef,
    contentRef: pageInnerRef,
    resetKey: `${detail?.taskId ?? "loading"}:${props.activeRunId ?? "none"}:${showRawLog ? "raw" : "chat"}`,
    contentVersion: `${props.runEvents.length}:${props.events.length}:${localSteers.length}:${assistantLen}:${detail?.status ?? ""}`,
  });
  const rawScroll = useAutoScroll({
    scrollRef: rawLogRef,
    resetKey: `${detail?.taskId ?? "loading"}:${props.activeRunId ?? "none"}:${showRawLog ? "raw" : "chat"}`,
    contentVersion: props.runEvents.length,
  });

  if (!detail) {
    return (
      <div className="task-page">
        <div className="task-page-bar">
          <button type="button" className="btn btn-sm" onClick={props.onBack}>
            ← 返回主对话
          </button>
          <span className="muted small">加载任务详情…</span>
        </div>
        <div className="task-page-scroll">
          <div className="task-page-inner">
            <div className="empty-box">正在同步任务状态…</div>
          </div>
        </div>
      </div>
    );
  }

  const isTerminal = detail.status === "completed" || detail.status === "failed" || detail.status === "stopped";
  const isRunning = detail.status === "accepted" || detail.status === "running" || detail.status === "verifying";
  const decisionAction = decision?.action ?? null;
  const watchdog = props.events.filter((event) => event.type === "watchdog_signal").at(-1);

  const assistantText =
    detail.result && typeof detail.result === "object" && typeof (detail.result as { assistantText?: unknown }).assistantText === "string"
      ? (detail.result as { assistantText: string }).assistantText.trim()
      : "";

  const modifiedRepos = (detail.repos ?? []).filter(
    (repo) => (repo.headSha && repo.baseSha && repo.headSha !== repo.baseSha) || Boolean(repo.mrId),
  );

  const copyConclusion = () => {
    if (!assistantText) return;
    void navigator.clipboard?.writeText(assistantText).then(() => {
      setCopiedConclusion(true);
      window.setTimeout(() => setCopiedConclusion(false), 1500);
    });
  };

  const submitSteer = () => {
    const msg = steerText.trim();
    if (!msg) return;
    setSteerText("");
    const id = `steer-${Date.now()}`;
    pageScroll.scrollToBottom("smooth");
    void props.onSteer(detail.taskId, msg).then((res) => {
      setLocalSteers((prev) => [...prev, { id, text: msg, at: Date.now(), accepted: res.accepted, reason: res.reason }]);
      pageScroll.scrollToBottom("smooth");
    });
  };

  return (
    <div className="task-page">
      {/* Sticky Task Header */}
      <header className="task-page-bar">
        <div className="task-page-bar-left">
          <button type="button" className="btn btn-sm" onClick={props.onBack}>
            ← 返回主对话
          </button>
          <span className="vsep" />
          <span className={statusDot(detail.status, isRunning)} />
          {editingTitle ? (
            <div className="row" style={{ gap: 6, flex: 1, minWidth: 0 }}>
              <input
                className="input"
                style={{ maxWidth: 360 }}
                value={titleDraft}
                maxLength={120}
                autoFocus
                placeholder="输入任务标题（留空恢复默认）"
                onChange={(event) => setTitleDraft(event.target.value)}
                {...ime.compositionProps}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !ime.isImeEvent(event)) {
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
            <div className="row" style={{ gap: 8, minWidth: 0 }}>
              <h1
                className="task-page-title"
                title="双击重命名"
                onDoubleClick={() => {
                  setTitleDraft(detail.title ?? "");
                  setEditingTitle(true);
                }}
              >
                {detail.title || detail.taskId.slice(0, 8)}
              </h1>
              <button
                type="button"
                className="btn-link"
                style={{ flexShrink: 0 }}
                onClick={() => {
                  setTitleDraft(detail.title ?? "");
                  setEditingTitle(true);
                }}
              >
                重命名
              </button>
            </div>
          )}
          <span className={`status-pill status-${detail.status}`} style={{ marginLeft: 4 }}>
            {STATUS_LABEL[detail.status] ?? detail.status}
            {detail.archivedAt ? " · 已归档" : ""}
          </span>
          {detail.executorId && (
            <span className="msg-agent-tag">
              <AgentLogo id={detail.executorId} size={12} />
              <span>{agentLabel(detail.executorId)}</span>
            </span>
          )}
          <span className="mono muted small" style={{ flexShrink: 0 }}>
            {detail.taskId.slice(0, 8)}
          </span>
        </div>

        <div className="task-page-bar-actions">
          {confirmStop ? (
            <>
              <span className="muted small">确认停止并作废当前执行？</span>
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
            </>
          ) : confirmDelete ? (
            <>
              <span className="muted small">{!isTerminal ? "任务仍在运行，强停并删除？" : "删除后不可恢复，确认？"}</span>
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
            </>
          ) : (
            <>
              {(detail.status === "failed" || detail.status === "stopped" || detail.status === "waiting") && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => props.onRetry(detail.taskId)}>
                  重试任务
                </button>
              )}
              {!isTerminal && (
                <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmStop(true)}>
                  停止任务
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => props.onArchiveTask(detail.taskId, !detail.archivedAt)}
              >
                {detail.archivedAt ? "取消归档" : "归档"}
              </button>
              <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>
                删除
              </button>
            </>
          )}
        </div>
      </header>

      {/* Scrollable Spacious Task Body */}
      <div className="task-page-scroll" ref={pageScrollRef}>
        <div className="task-page-inner" ref={pageInnerRef}>
          {/* Priority Human Action Banners */}
          {decision && decisionAction && (
            <section className="card task-banner-card is-warning">
              <header className="card-head">
                <span className="row" style={{ gap: 6 }}>
                  <span className="dot dot-warning dot-pulse" />
                  <span>需要你拍板</span>
                </span>
                <span className="mono muted small">{decisionAction}</span>
              </header>
              <div className="card-body row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <div className="small">{decision.summary}</div>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => props.onResolve(detail.taskId, decisionAction, true)}
                  >
                    批准并恢复
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

          {blocked && detail.status === "failed" && (
            <section className="card task-banner-card is-error">
              <header className="card-head">
                <span className="row" style={{ gap: 6 }}>
                  <span className="dot dot-error" />
                  <span>任务已阻塞</span>
                </span>
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => props.onDismissInbox(detail.taskId, blocked.decisionKey)}
                >
                  移出待处理
                </button>
              </header>
              <div className="card-body row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <div className="small" style={{ color: "var(--error)" }}>{blocked.summary}</div>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => props.onRetry(detail.taskId)}>
                  重新执行
                </button>
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
                <div className="row" style={{ gap: 6 }}>
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
            <section key={op.operationId} className="card task-banner-card is-warning">
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
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
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

          {/* Main 2-Column Task Detail Grid */}
          <div className="task-page-grid">
            {/* Primary Left Column: Codex-style Chat Timeline (auto-collapsed tools + Markdown conclusion + Steer) */}
            <div className="task-page-main stack" style={{ gap: 14 }}>
              <section className="card">
                <header className="card-head">
                  <span className="row" style={{ gap: 7 }}>
                    <span>执行进展与结论</span>
                    {isRunning && (
                      <span className="row small muted" style={{ gap: 5, fontWeight: 400 }}>
                        <span className="dot dot-warning dot-pulse" />
                        <span>实时同步中</span>
                      </span>
                    )}
                  </span>
                  <div className="row" style={{ gap: 8 }}>
                    {props.runIds.length > 1 ? (
                      <select
                        aria-label="选择运行记录"
                        className="chip-select mono"
                        value={props.activeRunId ?? ""}
                        onChange={(event) => props.onSelectRun(event.target.value)}
                      >
                        {props.runIds.map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                    ) : props.activeRunId ? (
                      <span className="mono muted small">{props.activeRunId}</span>
                    ) : null}
                    <div className="seg">
                      <button
                        type="button"
                        className={!showRawLog ? "active" : ""}
                        onClick={() => setShowRawLog(false)}
                      >
                        对话视图
                      </button>
                      <button
                        type="button"
                        className={showRawLog ? "active" : ""}
                        onClick={() => setShowRawLog(true)}
                      >
                        实时流
                      </button>
                    </div>
                  </div>
                </header>
                <div className="card-body stack" style={{ gap: 12 }}>
                  {showRawLog ? (
                    <div className="task-event-log" ref={rawLogRef}>
                      {props.runEvents.length === 0 ? (
                        <div className="empty-box">{isRunning ? "等待执行器输出实时步骤…" : "暂无原始事件"}</div>
                      ) : (
                        props.runEvents.map((ev) => (
                          <div key={`${ev.runId}:${ev.seq}`} className="event-line" style={{ alignItems: "flex-start" }}>
                            <span className="seq mono">{String(ev.seq).padStart(2, "0")}</span>
                            <span className={`event-type-tag mono event-type-${ev.type}`}>{ev.type}</span>
                            <span style={{ wordBreak: "break-word", flex: 1 }}>{ev.summary}</span>
                            <span className="muted mono" style={{ fontSize: 10, flexShrink: 0 }}>
                              {new Date(ev.at).toLocaleTimeString()}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  ) : (
                    <div className="task-timeline-flow">
                      <TaskTimeline
                        requestText={detail.requestText}
                        status={detail.status}
                        isRunning={isRunning}
                        assistantText={assistantText}
                        failureReason={!blocked ? detail.failureReason : null}
                        runEvents={props.runEvents}
                        taskEvents={props.events}
                        localSteers={localSteers}
                        hasActiveRun={Boolean(props.activeRunId)}
                        onCopyConclusion={assistantText ? copyConclusion : undefined}
                        copiedConclusion={copiedConclusion}
                      />
                    </div>
                  )}

                  {!isTerminal && (
                    <div className="task-steer-bar">
                      <input
                        className="input"
                        placeholder="向当前运行中的任务发送纠偏指令（Enter 发送）…"
                        value={steerText}
                        onChange={(event) => setSteerText(event.target.value)}
                        {...ime.compositionProps}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !ime.isImeEvent(event) && steerText.trim() !== "") {
                            event.preventDefault();
                            submitSteer();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        style={{ flexShrink: 0 }}
                        disabled={steerText.trim() === ""}
                        onClick={submitSteer}
                      >
                        发送纠偏
                      </button>
                    </div>
                  )}
                </div>
              </section>
            </div>

            {/* Right Evidence & Control Rail */}
            <aside className="task-page-rail stack" style={{ gap: 12 }}>
              <section className="card">
                <header className="card-head">
                  <span>任务概览</span>
                  <span className="mono muted small">v{detail.briefVersion}</span>
                </header>
                <div className="card-body stack" style={{ gap: 10 }}>
                  {detail.requestText && (() => {
                    const req = detail.requestText.trim();
                    const isLong = req.length > 160 || req.split("\n").length > 4;
                    return (
                      <div className="card-box small stack" style={{ gap: 6, wordBreak: "break-word" }}>
                        <div className={isLong && !railReqExpanded ? "rail-req-clamped" : ""} style={{ whiteSpace: "pre-wrap" }}>
                          {req}
                        </div>
                        {isLong && (
                          <button
                            type="button"
                            className="btn-link"
                            style={{ alignSelf: "flex-start" }}
                            onClick={() => setRailReqExpanded((v) => !v)}
                          >
                            {railReqExpanded ? "收起需求 ⌃" : "查看全部需求 ⌄"}
                          </button>
                        )}
                      </div>
                    );
                  })()}
                  <dl className="kv">
                    <dt>状态</dt>
                    <dd>{STATUS_LABEL[detail.status] ?? detail.status}</dd>
                    <dt>执行器</dt>
                    <dd className="mono">{detail.executorId ?? "—"}</dd>
                    <dt>等待原因</dt>
                    <dd>{detail.waitingReason ?? "—"}</dd>
                    <dt>创建时间</dt>
                    <dd className="mono">{formatDateTime(detail.createdAt)}</dd>
                    <dt>最近更新</dt>
                    <dd className="mono">{formatDateTime(detail.updatedAt)}</dd>
                  </dl>
                </div>
              </section>

              {modifiedRepos.length > 0 && (
                <section className="card">
                  <header className="card-head">
                    <span>代码改动与交付物</span>
                    <span className="mono muted small">
                      {(detail.result as { productionDeployed?: boolean } | null)?.productionDeployed === false
                        ? "生产未发布"
                        : `${modifiedRepos.length} 仓`}
                    </span>
                  </header>
                  <div className="card-body stack small">
                    {modifiedRepos.map((repo) => (
                      <div key={repo.name} className="card-box stack" style={{ gap: 4 }}>
                        <div className="row">
                          <span className={ciDot(repo.ciStatus)} />
                          <span className="mono" style={{ fontWeight: 600 }}>{repo.name}</span>
                          <span className="muted mono" style={{ marginLeft: "auto", fontSize: 11 }}>
                            {repo.baseRef}
                          </span>
                        </div>
                        <div className="muted mono" style={{ fontSize: 11 }}>
                          {shortSha(repo.baseSha)} → {shortSha(repo.headSha)}
                        </div>
                        {(repo.mrId || repo.ciStatus) && (
                          <div className="row mono" style={{ fontSize: 11 }}>
                            <span>
                              MR:{" "}
                              {repo.mrUrl ? (
                                <a href={repo.mrUrl} target="_blank" rel="noopener noreferrer" className="md-link">
                                  {repo.mrId ?? "查看"}
                                </a>
                              ) : (
                                repo.mrId ?? "—"
                              )}
                            </span>
                            <span style={{ marginLeft: "auto" }}>CI: {repo.ciStatus ?? "—"}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {detail.kind !== "assistant_chat" && (
                <section className="card">
                  <header className="card-head">
                    <span>独立验收</span>
                    {detail.result !== null && (
                      <button type="button" className="btn-link" onClick={() => setShowProof((open) => !open)}>
                        {showProof ? "收起 JSON" : "查看 JSON"}
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
                        <div className="muted" style={{ fontSize: 11 }}>
                          {new Date(detail.verification.createdAt).toLocaleString()}
                        </div>
                      </>
                    ) : (
                      <div className="muted">尚无验收记录（代码提交后自动执行）</div>
                    )}
                    {detail.result !== null && showProof && (
                      <pre className="card-box mono" style={{ margin: 0, whiteSpace: "pre-wrap", maxHeight: 280, overflow: "auto" }}>
                        {JSON.stringify(detail.result, null, 2)}
                      </pre>
                    )}
                  </div>
                </section>
              )}

              <details className="card" style={{ padding: 0 }}>
                <summary className="card-head" style={{ cursor: "pointer", listStyle: "none" }}>
                  <span>高级控制与运行元信息</span>
                  <span className="muted small">展开 ⌄</span>
                </summary>
                <div className="card-body stack" style={{ gap: 10 }}>
                  <div className="stack small">
                    <div className="row">
                      <span className={watchdog ? "dot dot-warning" : "dot dot-success"} />
                      <span>{watchdog ? `看门狗告警：${String((watchdog.payload as Record<string, unknown>).kind ?? "")}` : "看门狗健康"}</span>
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

                  {!isTerminal && (
                    <div className="stack small" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                      <div style={{ fontWeight: 600 }}>起草约定变更（两阶段确认）</div>
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
                  )}

                  {!isTerminal && detail.kind === "repo_delivery" && readyExecutors.length > 0 && (
                    <div className="stack small" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                      <div style={{ fontWeight: 600 }}>切换执行器交接</div>
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
                  )}
                </div>
              </details>
            </aside>
          </div>
        </div>
      </div>
      <ScrollToBottomButton
        visible={showRawLog ? rawScroll.showScrollButton || pageScroll.showScrollButton : pageScroll.showScrollButton}
        active={isRunning}
        onClick={() => {
          if (showRawLog) rawScroll.scrollToBottom("smooth");
          pageScroll.scrollToBottom("smooth");
        }}
      />
    </div>
  );
}

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : "—";
}

function formatDateTime(raw: string | null | undefined): string {
  if (!raw) return "—";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
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

function statusDot(status: string, pulse = false): string {
  const base =
    status === "completed"
      ? "dot dot-success"
      : status === "failed"
        ? "dot dot-error"
        : status === "waiting" || status === "running" || status === "verifying" || status === "accepted"
          ? "dot dot-warning"
          : "dot";
  return pulse ? `${base} dot-pulse` : base;
}
