import { useEffect, useRef, useState } from "react";
import type { InboxItem, TaskSummary } from "../api.js";

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

function statusDot(status: string): string {
  if (status === "completed") return "dot dot-success";
  if (status === "failed") return "dot dot-error";
  if (status === "waiting" || status === "running" || status === "verifying" || status === "accepted") return "dot dot-warning";
  return "dot";
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

export function Sidebar(props: {
  tasks: TaskSummary[];
  inbox: InboxItem[];
  selectedTaskId: string | null;
  chatActive: boolean;
  hasChatMessages: boolean;
  onFocusMainChat: () => void;
  onClearChat: () => void;
  onSelectTask: (taskId: string) => void;
  onRenameTask: (taskId: string, title: string) => void;
  onArchiveTask: (taskId: string, archived: boolean) => void;
  onDeleteTask: (taskId: string, force: boolean) => void;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const [filter, setFilter] = useState<"active" | "archived">("active");
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  // Filter out legacy conversational tasks (`assistant_chat`) from the engineering
  // task list so casual greetings never clutter background delivery tasks.
  const engineeringTasks = props.tasks.filter((t) => t.kind !== "assistant_chat");
  const activeTasks = engineeringTasks.filter((t) => !t.archivedAt);
  const archivedTasks = engineeringTasks.filter((t) => Boolean(t.archivedAt));
  const visibleTasks = filter === "archived" ? archivedTasks : activeTasks;
  const taskById = new Map(props.tasks.map((t) => [t.taskId, t]));

  useEffect(() => {
    if (!menuTaskId) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuTaskId(null);
        setConfirmDeleteId(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menuTaskId]);

  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  const startRename = (task: TaskSummary) => {
    setMenuTaskId(null);
    setConfirmDeleteId(null);
    setRenamingId(task.taskId);
    setRenameDraft(task.title || "");
  };

  const commitRename = (taskId: string) => {
    const next = renameDraft.trim();
    setRenamingId(null);
    props.onRenameTask(taskId, next);
  };

  return (
    <div className="sidebar-shell">
      <div className="sidebar-top">
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className={props.chatActive ? "nav-primary-btn active" : "nav-primary-btn"}
            onClick={props.onFocusMainChat}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>主对话</span>
          </button>
          {props.hasChatMessages && (
            <button
              type="button"
              className="icon-btn"
              title="清空主对话记录"
              onClick={props.onClearChat}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <section className="sidebar-inbox" aria-label="待我处理">
        <div className="group-label" style={{ marginTop: 4 }}>
          <span>待我处理</span>
          {props.inbox.length > 0 ? (
            <span className="badge-count mono">{props.inbox.length}</span>
          ) : (
            <span className="muted mono" style={{ marginLeft: "auto", fontSize: 11 }}>0</span>
          )}
        </div>
        {props.inbox.length === 0 ? (
          <div className="inbox-empty">暂无待处理项</div>
        ) : (
          <div className="nav-list sidebar-inbox-list">
            {props.inbox.map((item) => {
              const linked = taskById.get(item.taskId);
              const badge = item.decisionKey === "decision_required" ? "需批准" : "已阻塞";
              const dotClass = item.decisionKey === "task_blocked_final" ? "dot dot-error" : "dot dot-warning";
              return (
                <button
                  key={`${item.taskId}:${item.decisionKey}`}
                  type="button"
                  className={props.selectedTaskId === item.taskId ? "nav-item active" : "nav-item"}
                  onClick={() => props.onSelectTask(item.taskId)}
                >
                  <span className="row" style={{ gap: 6, minWidth: 0 }}>
                    <span className={dotClass} style={{ flexShrink: 0 }} />
                    <span className="t">{linked?.title || item.title}</span>
                    <span className="inbox-tag" style={{ marginLeft: "auto", flexShrink: 0 }}>{badge}</span>
                  </span>
                  <span className="s inbox-summary">{item.summary}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <div className="sidebar-scroll">
        <div className="group-label">
          <span>{filter === "archived" ? "已归档任务" : "任务"}</span>
          {visibleTasks.length > 0 && <span className="muted mono" style={{ fontSize: 11 }}>{visibleTasks.length}</span>}
          <button
            type="button"
            className={filter === "archived" ? "sidebar-filter-btn active" : "sidebar-filter-btn"}
            style={{ marginLeft: "auto" }}
            onClick={() => {
              setMenuTaskId(null);
              setConfirmDeleteId(null);
              setFilter((cur) => (cur === "active" ? "archived" : "active"));
            }}
            title={filter === "archived" ? "返回活跃任务" : "查看已归档任务"}
          >
            {filter === "archived" ? `返回活跃 (${activeTasks.length})` : archivedTasks.length > 0 ? `已归档 (${archivedTasks.length})` : "已归档"}
          </button>
        </div>

        {visibleTasks.length === 0 ? (
          <div className="empty-box">{filter === "archived" ? "暂无已归档任务" : "暂无后台任务"}</div>
        ) : (
          <div className="nav-list">
            {visibleTasks.map((task) => {
              const isSelected = props.selectedTaskId === task.taskId;
              const isRenaming = renamingId === task.taskId;
              const isMenuOpen = menuTaskId === task.taskId;
              const isConfirmingDelete = confirmDeleteId === task.taskId;
              const activeRun = !isTerminalStatus(task.status);
              return (
                <div
                  key={task.taskId}
                  className={[
                    "nav-item-wrap",
                    isSelected ? "active" : "",
                    isMenuOpen ? "menu-open" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {isRenaming ? (
                    <div className="nav-rename-box">
                      <input
                        ref={renameInputRef}
                        className="input"
                        value={renameDraft}
                        placeholder="输入任务标题（留空恢复默认）"
                        maxLength={120}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            commitRename(task.taskId);
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setRenamingId(null);
                          }
                        }}
                        onBlur={() => commitRename(task.taskId)}
                      />
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="nav-item-main"
                        onClick={() => props.onSelectTask(task.taskId)}
                      >
                        <span className="row" style={{ gap: 6, minWidth: 0 }}>
                          <span className={statusDot(task.status)} />
                          <span className="t">{task.title || task.taskId.slice(0, 8)}</span>
                        </span>
                        <span className="s">
                          {STATUS_LABEL[task.status] ?? task.status}
                          {task.repoNames && task.repoNames.length === 1
                            ? ` · ${task.repoNames[0]}`
                            : task.repoNames && task.repoNames.length > 1
                              ? ` · ${task.repoNames[0]} +${task.repoNames.length - 1}`
                              : ""}
                        </span>
                      </button>

                      <button
                        type="button"
                        className="nav-item-more"
                        aria-label="管理任务"
                        title="管理任务"
                        onClick={(event) => {
                          event.stopPropagation();
                          setConfirmDeleteId(null);
                          setMenuTaskId((cur) => (cur === task.taskId ? null : task.taskId));
                        }}
                      >
                        ⋯
                      </button>

                      {isMenuOpen && (
                        <div className="task-menu" ref={menuRef} onClick={(event) => event.stopPropagation()}>
                          {isConfirmingDelete ? (
                            <div className="task-menu-confirm">
                              <div className="small muted">
                                {activeRun ? "任务仍在运行，确认强停并删除？" : "删除后不可恢复，确认删除？"}
                              </div>
                              <div className="row" style={{ justifyContent: "flex-end", gap: 6, marginTop: 6 }}>
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  onClick={() => setConfirmDeleteId(null)}
                                >
                                  取消
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-danger-solid btn-sm"
                                  onClick={() => {
                                    setMenuTaskId(null);
                                    setConfirmDeleteId(null);
                                    props.onDeleteTask(task.taskId, activeRun);
                                  }}
                                >
                                  {activeRun ? "强停并删除" : "确认删除"}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <button type="button" className="task-menu-item" onClick={() => startRename(task)}>
                                重命名
                              </button>
                              <button
                                type="button"
                                className="task-menu-item"
                                onClick={() => {
                                  setMenuTaskId(null);
                                  props.onArchiveTask(task.taskId, !task.archivedAt);
                                }}
                              >
                                {task.archivedAt ? "取消归档" : "归档"}
                              </button>
                              <div className="task-menu-sep" />
                              <button
                                type="button"
                                className="task-menu-item danger"
                                onClick={() => setConfirmDeleteId(task.taskId)}
                              >
                                删除任务
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <button type="button" className="sidebar-foot" onClick={props.onOpenSettings} title="设置">
        <span className="row" style={{ gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>设置</span>
        </span>
      </button>
    </div>
  );
}
