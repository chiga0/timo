import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, InboxItem, TaskProgressFrame, TaskSummary } from "../api.js";
import { AgentLogo, agentLabel } from "./AgentIcons.js";
import { Markdown } from "./Markdown.js";
import {
  ConversationMinimap,
  ScrollToBottomButton,
  stripMarkdownPreview,
  useAutoScroll,
  type NavTickItem,
} from "./ScrollNav.js";

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

const STARTER_PROMPTS = [
  "介绍一下我当前工作区有哪些目录，以及你能帮我做什么？",
  "帮我汇总一下当前有没有待处理或卡住的后台任务",
  "我想重构一个模块，先帮我列一份工程交付检查清单",
];

const CONCLUSION_COLLAPSED_HEIGHT = 240;

/**
 * Fixed global Main Chat (`User <-> Timo Chief of Staff`).
 *
 * - Never bound to a single Task: casual Q&A streams directly as Markdown here.
 * - Delegated engineering tasks appear inline as a single live-updating Task Card:
 *   running shows a clean 1-line progress bar; completed renders the Markdown
 *   final conclusion capped at 240px with an inline expand/collapse toggle,
 *   plus "查看详情 →" to open the dedicated Task Detail page.
 */
export function Thread(props: {
  messages: ChatMessage[];
  tasks: TaskSummary[];
  inbox: InboxItem[];
  liveProgress: Record<string, TaskProgressFrame>;
  onQuickPrompt: (text: string) => void;
  onOpenTask: (taskId: string) => void;
  onStopChat: (messageId: string) => void;
  onStopTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
  onResolveDecision: (taskId: string, action: string, approved: boolean) => void;
  onDismissInbox: (taskId: string, decisionKey: string) => void;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const taskById = useMemo(() => new Map(props.tasks.map((t) => [t.taskId, t])), [props.tasks]);
  const inboxByTaskId = useMemo(() => {
    const map = new Map<string, InboxItem[]>();
    for (const item of props.inbox) {
      const arr = map.get(item.taskId) ?? [];
      arr.push(item);
      map.set(item.taskId, arr);
    }
    return map;
  }, [props.inbox]);

  const lastMsg = props.messages.at(-1);
  const isStreaming = props.messages.some((m, idx) => {
    if (m.role !== "assistant" || m.status !== "streaming") return false;
    return !props.messages.slice(idx + 1).some((later) => later.role === "user");
  });

  // Auto-snap to bottom on mount/refresh & follow new chunks only when user stays near bottom.
  const firstMsgId = props.messages[0]?.messageId ?? "empty";
  const { showScrollButton, scrollToBottom, suspendFollow } = useAutoScroll({
    scrollRef,
    contentRef: innerRef,
    resetKey: firstMsgId === "empty" ? "empty" : "loaded",
    contentVersion: `${props.messages.length}:${lastMsg?.messageId ?? ""}:${lastMsg?.content.length ?? 0}:${lastMsg?.status ?? ""}`,
  });

  // Build Codex-style left prompt navigation ticks (one tick per user prompt turn).
  const navItems = useMemo<NavTickItem[]>(() => {
    const turns: NavTickItem[] = [];
    for (let i = 0; i < props.messages.length; i += 1) {
      const msg = props.messages[i]!;
      if (msg.role !== "user") continue;
      const prompt = msg.content.replace(/\s+/g, " ").trim() || "(空提问)";
      let preview = "";
      let badge: string | undefined;
      for (let j = i + 1; j < props.messages.length; j += 1) {
        const next = props.messages[j]!;
        if (next.role === "user") break;
        if (next.role === "task_card" && next.taskId) {
          const task = taskById.get(next.taskId);
          const taskInbox = inboxByTaskId.get(next.taskId) ?? [];
          const decision = taskInbox.find((it) => it.decisionKey === "decision_required");
          const blocked = taskInbox.find((it) => it.decisionKey === "task_blocked_final");
          badge = task ? (STATUS_LABEL[task.status] ?? task.status) : "任务";
          preview =
            task?.status === "completed" && task.resultSummary?.trim()
              ? stripMarkdownPreview(task.resultSummary, 160)
              : buildLiveLine(task, props.liveProgress[next.taskId], decision, blocked);
          break;
        }
        if (next.role === "assistant") {
          const hasLaterUser = props.messages.slice(j + 1).some((m) => m.role === "user");
          const activelyStreaming = next.status === "streaming" && !hasLaterUser;
          if (activelyStreaming) badge = "回复中";
          preview = next.content.trim()
            ? stripMarkdownPreview(next.content, 160)
            : activelyStreaming
              ? "正在思考中…"
              : "已完成";
          break;
        }
      }
      turns.push({ id: msg.messageId, prompt, preview, badge });
    }
    return turns;
  }, [props.messages, taskById, inboxByTaskId, props.liveProgress]);

  return (
    <div className="thread-stage">
      <ConversationMinimap
        items={navItems}
        scrollRef={scrollRef}
        onJump={() => suspendFollow()}
      />
      <div className={navItems.length >= 2 ? "thread has-minimap" : "thread"} ref={scrollRef}>
        <div className="thread-inner" ref={innerRef}>
        {props.messages.length === 0 ? (
          <div className="welcome">
            <div className="welcome-mark">T</div>
            <h1 className="welcome-title">我是 Timo，一切交给我，除了隐私。</h1>
            <div className="starter-row">
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="starter-chip"
                  onClick={() => props.onQuickPrompt(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          props.messages.map((msg, msgIdx) => {
            if (msg.role === "user") {
              return (
                <div key={msg.messageId} data-nav-id={msg.messageId} className="msg-user-wrap">
                  <div className="msg-user">{msg.content}</div>
                </div>
              );
            }

            if (msg.role === "task_card" && msg.taskId) {
              const task = taskById.get(msg.taskId);
              const taskInbox = inboxByTaskId.get(msg.taskId) ?? [];
              const live = props.liveProgress[msg.taskId];
              return (
                <InlineTaskCard
                  key={msg.messageId}
                  message={msg}
                  task={task}
                  inboxItems={taskInbox}
                  live={live}
                  onOpen={() => props.onOpenTask(msg.taskId!)}
                  onStop={() => props.onStopTask(msg.taskId!)}
                  onRetry={() => props.onRetryTask(msg.taskId!)}
                  onResolve={(action, approved) => props.onResolveDecision(msg.taskId!, action, approved)}
                  onDismiss={(key) => props.onDismissInbox(msg.taskId!, key)}
                />
              );
            }

            // Never render a zombie blinking caret on an older message superseded by a newer user turn.
            const hasNewerUserTurn = props.messages.slice(msgIdx + 1).some((m) => m.role === "user");
            const isActivelyStreaming = msg.status === "streaming" && !hasNewerUserTurn;

            return (
              <div key={msg.messageId} className="msg-assistant">
                <div className="msg-assistant-head">
                  <span className="msg-avatar">T</span>
                  <span className="msg-assistant-name">Timo</span>
                  {msg.executorId && (
                    <span className="msg-agent-tag">
                      <AgentLogo id={msg.executorId} size={12} />
                      <span>{agentLabel(msg.executorId)}</span>
                    </span>
                  )}
                  {isActivelyStreaming && (
                    <button
                      type="button"
                      className="btn-link"
                      style={{ marginLeft: "auto" }}
                      onClick={() => props.onStopChat(msg.messageId)}
                    >
                      停止生成
                    </button>
                  )}
                </div>
                <div className="msg-assistant-body">
                  {msg.content ? (
                    <>
                      <Markdown content={msg.content} />
                      {isActivelyStreaming && <span className="stream-caret" aria-hidden="true" />}
                    </>
                  ) : isActivelyStreaming ? (
                    <div className="thinking-line">
                      <span className="dot dot-warning dot-pulse" />
                      <span className="muted">思考中…</span>
                    </div>
                  ) : (
                    <span className="muted">已完成</span>
                  )}
                </div>
              </div>
            );
          })
        )}
        </div>
      </div>
      <ScrollToBottomButton
        visible={showScrollButton && props.messages.length > 0}
        active={isStreaming}
        onClick={() => scrollToBottom("smooth")}
      />
    </div>
  );
}

function InlineTaskCard(props: {
  message: ChatMessage;
  task?: TaskSummary;
  inboxItems: InboxItem[];
  live?: TaskProgressFrame;
  onOpen: () => void;
  onStop: () => void;
  onRetry: () => void;
  onResolve: (action: string, approved: boolean) => void;
  onDismiss: (decisionKey: string) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const conclusionRef = useRef<HTMLDivElement | null>(null);

  const task = props.task;
  const status = task?.status ?? "accepted";
  const isRunning = status === "accepted" || status === "running" || status === "verifying";
  const canStop = isRunning || status === "waiting";
  const canRetry = status === "failed" || status === "stopped";
  const decision = props.inboxItems.find((i) => i.decisionKey === "decision_required");
  const blocked = props.inboxItems.find((i) => i.decisionKey === "task_blocked_final");
  const title = task?.title || props.message.content.split("\n")[0]?.slice(0, 48) || "后台任务";
  const execId = task?.executorId || props.message.executorId;
  const conclusion = status === "completed" ? (task?.resultSummary?.trim() || "") : "";
  const liveLine = buildLiveLine(task, props.live, decision, blocked);
  const repoLabel = task?.repoNames && task.repoNames.length > 0 ? task.repoNames.join("、") : "";

  useEffect(() => {
    const el = conclusionRef.current;
    if (!el || !conclusion) {
      setOverflows(false);
      return;
    }
    const measure = () => {
      setOverflows(el.scrollHeight > CONCLUSION_COLLAPSED_HEIGHT + 8);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [conclusion, expanded]);

  return (
    <article className="live-task-card">
      <div
        className="live-task-head"
        role="button"
        tabIndex={0}
        onClick={props.onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onOpen();
          }
        }}
      >
        <span className={statusDot(status, isRunning)} />
        <span className="live-task-title">{title}</span>
        {execId && (
          <span className="live-task-meta">
            <AgentLogo id={execId} size={12} />
            <span>{agentLabel(execId)}</span>
          </span>
        )}
        <span className={`status-pill status-${status}`}>
          {STATUS_LABEL[status] ?? status}
        </span>
      </div>

      {conclusion ? (
        <div className="task-conclusion-box">
          <div
            ref={conclusionRef}
            className={expanded ? "task-conclusion-content is-expanded" : "task-conclusion-content"}
          >
            <Markdown content={conclusion} />
          </div>
          {!expanded && overflows && <div className="task-conclusion-fade" aria-hidden="true" />}
          {overflows && (
            <button
              type="button"
              className="task-conclusion-toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "收起结论 ⌃" : "展开完整结论 ⌄"}
            </button>
          )}
        </div>
      ) : (
        <div className="live-task-body">
          <span className={status === "failed" ? "live-task-line is-error" : "live-task-line"}>
            {liveLine}
          </span>
        </div>
      )}

      <div className="live-task-foot">
        {decision && decision.action && task?.waitingReason === "needs_human_decision" ? (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => props.onResolve(decision.action!, true)}>
              批准并恢复
            </button>
            <button type="button" className="btn btn-outline-muted btn-sm" onClick={() => props.onResolve(decision.action!, false)}>
              拒绝
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={props.onStop}>
              停止
            </button>
          </>
        ) : (
          <>
            {canRetry && (
              <button type="button" className="btn btn-primary btn-sm" onClick={props.onRetry}>
                重试任务
              </button>
            )}
            {blocked && (
              <button type="button" className="btn btn-outline-muted btn-sm" onClick={() => props.onDismiss(blocked.decisionKey)}>
                移出待处理
              </button>
            )}
            {canStop && (
              <button type="button" className="btn btn-danger btn-sm" onClick={props.onStop}>
                停止任务
              </button>
            )}
            {status === "completed" && (
              <span className="muted small">
                {repoLabel ? `${repoLabel} · 已通过独立验收` : "已完成交付"}
              </span>
            )}
          </>
        )}
        <button type="button" className="btn-link" style={{ marginLeft: "auto" }} onClick={props.onOpen}>
          查看详情 →
        </button>
      </div>
    </article>
  );
}

function buildLiveLine(
  task: TaskSummary | undefined,
  live: TaskProgressFrame | undefined,
  decision: InboxItem | undefined,
  blocked: InboxItem | undefined,
): string {
  if (!task) return "任务记录已删除或同步中…";
  if (decision && task.waitingReason === "needs_human_decision") {
    return `等待批准：${decision.action ?? decision.title} — ${decision.summary}`;
  }
  if (task.status === "failed") {
    const raw = blocked?.summary || task.failureReason || live?.summary || "执行未通过，点击「查看详情」排查原因";
    return raw.length > 140 ? `${raw.slice(0, 139)}…` : raw;
  }
  if (task.status === "completed") {
    const repos = task.repoNames && task.repoNames.length > 0 ? ` · ${task.repoNames.join("、")}` : "";
    return `已完成交付并通过独立验收${repos}`;
  }
  if (task.status === "stopped") {
    return "已停止，可随时点击「重试任务」重新执行";
  }
  if (task.status === "verifying") {
    return "代码已提交，正在隔离环境中运行独立验收…";
  }
  const latest = live?.summary || task.liveSummary;
  if (latest) {
    return formatProgressText(live?.type || task.liveType || "status", latest);
  }
  const repos = task.repoNames && task.repoNames.length > 0 ? `（工作区：${task.repoNames.join("、")}）` : "";
  return `正在准备执行环境${repos}…`;
}

function formatProgressText(type: string, summary: string): string {
  const clean = summary.replace(/\s+/g, " ").trim();
  const clipped = clean.length > 110 ? `${clean.slice(0, 109)}…` : clean;
  if (type === "tool_call") return `正在执行 ${clipped}`;
  if (type === "patch") return `已改动 ${clipped}`;
  if (type === "error") return `遇到异常：${clipped}`;
  return clipped;
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
