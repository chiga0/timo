import { useEffect, useRef } from "react";
import type { ChatMessage, InboxItem, TaskProgressFrame, TaskSummary } from "../api.js";
import { AgentLogo, agentLabel } from "./AgentIcons.js";
import { Markdown } from "./Markdown.js";

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

/**
 * Fixed global Main Chat (`User <-> Timo Chief of Staff`).
 *
 * - Never bound to a single Task: casual Q&A streams directly as Markdown here.
 * - Delegated engineering tasks appear inline as a single compact, live-updating
 *   Task Card (merging status + live progress + quick actions in one place).
 */
export function Thread(props: {
  messages: ChatMessage[];
  tasks: TaskSummary[];
  inbox: InboxItem[];
  liveProgress: Record<string, TaskProgressFrame>;
  selectedTaskId: string | null;
  onQuickPrompt: (text: string) => void;
  onSelectTask: (taskId: string) => void;
  onStopChat: (messageId: string) => void;
  onStopTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
  onResolveDecision: (taskId: string, action: string, approved: boolean) => void;
  onDismissInbox: (taskId: string, decisionKey: string) => void;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taskById = new Map(props.tasks.map((t) => [t.taskId, t]));
  const inboxByTaskId = new Map<string, InboxItem[]>();
  for (const item of props.inbox) {
    const arr = inboxByTaskId.get(item.taskId) ?? [];
    arr.push(item);
    inboxByTaskId.set(item.taskId, arr);
  }

  const lastMsg = props.messages.at(-1);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom || lastMsg?.status === "streaming") {
      el.scrollTop = el.scrollHeight;
    }
  }, [props.messages.length, lastMsg?.content.length]);

  return (
    <div className="thread" ref={scrollRef}>
      <div className="thread-inner">
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
          props.messages.map((msg) => {
            if (msg.role === "user") {
              return (
                <div key={msg.messageId} className="msg-user-wrap">
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
                  selected={props.selectedTaskId === msg.taskId}
                  onSelect={() => props.onSelectTask(msg.taskId!)}
                  onStop={() => props.onStopTask(msg.taskId!)}
                  onRetry={() => props.onRetryTask(msg.taskId!)}
                  onResolve={(action, approved) => props.onResolveDecision(msg.taskId!, action, approved)}
                  onDismiss={(key) => props.onDismissInbox(msg.taskId!, key)}
                />
              );
            }

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
                  {msg.status === "streaming" && (
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
                      {msg.status === "streaming" && <span className="stream-caret" aria-hidden="true" />}
                    </>
                  ) : msg.status === "streaming" ? (
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
  );
}

function InlineTaskCard(props: {
  message: ChatMessage;
  task?: TaskSummary;
  inboxItems: InboxItem[];
  live?: TaskProgressFrame;
  selected: boolean;
  onSelect: () => void;
  onStop: () => void;
  onRetry: () => void;
  onResolve: (action: string, approved: boolean) => void;
  onDismiss: (decisionKey: string) => void;
}): React.JSX.Element {
  const task = props.task;
  const status = task?.status ?? "accepted";
  const isRunning = status === "accepted" || status === "running" || status === "verifying";
  const canStop = isRunning || status === "waiting";
  const canRetry = status === "failed" || status === "stopped";
  const decision = props.inboxItems.find((i) => i.decisionKey === "decision_required");
  const blocked = props.inboxItems.find((i) => i.decisionKey === "task_blocked_final");
  const title = task?.title || props.message.content.split("\n")[0]?.slice(0, 48) || "后台任务";
  const execId = task?.executorId || props.message.executorId;

  const liveLine = buildLiveLine(task, props.live, decision, blocked);

  return (
    <article
      className={props.selected ? "live-task-card selected" : "live-task-card"}
      onClick={props.onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onSelect();
        }
      }}
    >
      <div className="live-task-head">
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

      <div className="live-task-body">
        <span className={status === "failed" ? "live-task-line is-error" : "live-task-line"}>
          {liveLine}
        </span>
      </div>

      <div className="live-task-foot" onClick={(e) => e.stopPropagation()}>
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
          </>
        )}
        <button type="button" className="btn-link" style={{ marginLeft: "auto" }} onClick={props.onSelect}>
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
    const raw = blocked?.summary || live?.summary || "执行未通过，点击「查看详情」排查原因";
    return raw.length > 120 ? `${raw.slice(0, 119)}…` : raw;
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
