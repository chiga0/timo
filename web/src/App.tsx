import { useEffect, useMemo, useRef, useState } from "react";
import {
  Api,
  ApiError,
  readSessionToken,
  subscribeChatStream,
  subscribeEvents,
  subscribeRunStream,
  type ChatContextSummary,
  type ChatMessage,
  type EfficiencyMetricsSnapshot,
  type ExecutorDescriptor,
  type ExecutorProviderCatalog,
  type InboxItem,
  type PolicySnapshot,
  type Proposal,
  type RunStreamEvent,
  type SettingsPayload,
  type SkillsPayload,
  type TaskDetail,
  type TaskEvent,
  type TaskProgressFrame,
  type TaskSummary,
} from "./api.js";
import { Composer, type ComposerSubmission } from "./components/Composer.js";
import { Palette } from "./components/Palette.js";
import { SettingsView, type SettingsSection, type ThemePreference } from "./components/SettingsView.js";
import { Sidebar } from "./components/Sidebar.js";
import { TaskDetailView } from "./components/TaskDetailView.js";
import { Thread } from "./components/Thread.js";
import { Topbar } from "./components/Topbar.js";

function readSavedComposerSelection(): { executorId: string | null; model: string } {
  try {
    const exec = window.localStorage.getItem("timo_selected_executor")?.trim() || null;
    const model = window.localStorage.getItem("timo_selected_model")?.trim() || "";
    return { executorId: exec, model };
  } catch {
    return { executorId: null, model: "" };
  }
}

function readInitialTheme(): ThemePreference {
  try {
    const saved = window.localStorage.getItem("timo_theme");
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    // ignore storage restriction
  }
  return "light";
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof ApiError) return false;
  if (error instanceof TypeError) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /failed to fetch|load failed|networkerror|network request failed|fetch/i.test(msg);
}

export interface WorkbenchState {
  messages: ChatMessage[];
  contextSummary: ChatContextSummary | null;
  skillsPayload: SkillsPayload | null;
  tasks: TaskSummary[];
  inbox: InboxItem[];
  liveProgress: Record<string, TaskProgressFrame>;
  policy: PolicySnapshot | null;
  executors: ExecutorDescriptor[];
  executorProviders: Record<string, ExecutorProviderCatalog>;
  metrics: EfficiencyMetricsSnapshot | null;
  settingsPayload: SettingsPayload | null;
  defaultRepoPath: string;
  selectedId: string | null;
  detail: TaskDetail | null;
  events: TaskEvent[];
  proposals: Proposal[];
  runIds: string[];
  activeRunId: string | null;
  runEvents: RunStreamEvent[];
  connection: "connecting" | "open" | "reconnecting" | "closed";
  error: string | null;
}

export function App(): React.JSX.Element {
  const api = useMemo(() => new Api(readSessionToken()), []);
  const [theme, setTheme] = useState<ThemePreference>(readInitialTheme);
  const [view, setView] = useState<"chat" | "task" | "settings">("chat");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("assistant");
  const [leftOpen, setLeftOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const initialSelection = useMemo(readSavedComposerSelection, []);
  const [selectedExecutorId, setSelectedExecutorId] = useState<string>(initialSelection.executorId || "qwen-code");
  const [selectedModel, setSelectedModel] = useState<string>(initialSelection.model);
  const hasManualExecRef = useRef<boolean>(Boolean(initialSelection.executorId));
  const lastSettingsDefaultRef = useRef<string | null>(null);
  const [state, setState] = useState<WorkbenchState>({
    messages: [],
    contextSummary: null,
    skillsPayload: null,
    tasks: [],
    inbox: [],
    liveProgress: {},
    policy: null,
    executors: [],
    executorProviders: {},
    metrics: null,
    settingsPayload: null,
    defaultRepoPath: "",
    selectedId: null,
    detail: null,
    events: [],
    proposals: [],
    runIds: [],
    activeRunId: null,
    runEvents: [],
    connection: "connecting",
    error: null,
  });
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = state.selectedId;
  const prevConnRef = useRef<WorkbenchState["connection"]>("connecting");

  const refresh = async (selectId?: string | null) => {
    try {
      const [chatRes, tasks, inbox, policy, health, metrics, settingsPayload, skillsPayload] = await Promise.all([
        api.getChat(200).catch(() => ({ messages: [] as ChatMessage[], contextSummary: undefined })),
        api.listTasks("all"),
        api.inbox(),
        api.policy(),
        api.health(),
        api.metrics(),
        api.getSettings().catch(() => null),
        api.getSkills().catch(() => null),
      ]);
      const requestedId = selectId === null ? null : (selectId ?? selectedRef.current);
      const nextId = requestedId && tasks.tasks.some((t) => t.taskId === requestedId) ? requestedId : null;
      const [detail, events, proposalsRes, runsRes] = nextId
        ? await Promise.all([api.getTask(nextId), api.taskEvents(nextId, 0), api.listProposals(nextId), api.taskRuns(nextId)])
        : [null, [], { proposals: [] }, { runs: [] as string[] }];
      const nextRunId = runsRes.runs[0] ?? null;
      setState((previous) => ({
        ...previous,
        messages: mergeMessages(previous.messages, chatRes.messages),
        contextSummary: chatRes.contextSummary ?? previous.contextSummary,
        skillsPayload: skillsPayload ?? previous.skillsPayload,
        tasks: tasks.tasks,
        inbox: inbox.items,
        policy,
        executors: health.executors ?? previous.executors,
        metrics,
        settingsPayload: settingsPayload ?? previous.settingsPayload,
        defaultRepoPath: health.defaultRepoPath ?? previous.defaultRepoPath,
        selectedId: nextId,
        detail,
        events,
        proposals: proposalsRes.proposals,
        runIds: runsRes.runs,
        activeRunId:
          previous.selectedId === nextId && previous.activeRunId && runsRes.runs.includes(previous.activeRunId)
            ? previous.activeRunId
            : nextRunId,
        connection: previous.connection === "reconnecting" || previous.connection === "connecting" ? "open" : previous.connection,
        error: null,
      }));
    } catch (error) {
      if (isNetworkError(error)) {
        setState((previous) => ({ ...previous, connection: "reconnecting" }));
      } else {
        setState((previous) => ({ ...previous, error: describe(error) }));
      }
    }
  };

  const refreshProviders = async (force = false) => {
    try {
      const res = await api.executorProviders(force);
      setState((previous) => ({ ...previous, executorProviders: res.providers ?? {} }));
    } catch {
      // Optional discovery endpoint
    }
  };

  useEffect(() => {
    void refresh();
    void refreshProviders(false);
    fetch("/api/health", { headers: readSessionToken() ? { authorization: `Bearer ${readSessionToken()}` } : {} }).catch(() => undefined);
  }, []);

  // Global task event stream (state transitions & inbox updates).
  useEffect(() => {
    let reloadTimer: number | null = null;
    const unsubscribe = subscribeEvents(
      readSessionToken(),
      0,
      (event) => {
        setState((previous) => {
          const touchesSelected = event.taskId === previous.selectedId;
          return {
            ...previous,
            events: touchesSelected ? [...previous.events, event].slice(-200) : previous.events,
          };
        });
        if (reloadTimer !== null) window.clearTimeout(reloadTimer);
        reloadTimer = window.setTimeout(() => void refresh(), 120);
      },
      (connection) => {
        const wasOffline = prevConnRef.current === "reconnecting" || prevConnRef.current === "closed";
        prevConnRef.current = connection;
        setState((previous) => ({
          ...previous,
          connection,
          ...(connection === "open" ? { error: null } : {}),
        }));
        if (connection === "open" && wasOffline) {
          void refresh();
          void refreshProviders(false);
        }
      },
    );
    return () => {
      if (reloadTimer !== null) window.clearTimeout(reloadTimer);
      unsubscribe();
    };
  }, []);

  // Global Main Chat SSE stream (real-time token deltas + compact live task progress).
  useEffect(() => {
    const unsubscribe = subscribeChatStream(readSessionToken(), {
      onMessage: (msg) => {
        setState((previous) => ({
          ...previous,
          messages: upsertChatMessage(previous.messages, msg),
        }));
      },
      onDelta: ({ messageId, content }) => {
        setState((previous) => ({
          ...previous,
          messages: previous.messages.map((m) =>
            m.messageId === messageId ? { ...m, content, status: "streaming" } : m,
          ),
        }));
      },
      onDone: (msg) => {
        setState((previous) => ({
          ...previous,
          messages: upsertChatMessage(previous.messages, msg),
        }));
      },
      onTaskProgress: (frame) => {
        setState((previous) => ({
          ...previous,
          liveProgress: { ...previous.liveProgress, [frame.taskId]: frame },
        }));
      },
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("timo_theme", theme);
    } catch {
      // ignore
    }
    const apply = (resolved: "light" | "dark") => {
      document.documentElement.className = `theme-${resolved}`;
    };
    if (theme !== "system") {
      apply(theme);
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    apply(media.matches ? "dark" : "light");
    const onChange = (event: MediaQueryListEvent) => apply(event.matches ? "dark" : "light");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) {
        return;
      }
      if (event.key === "[") setLeftOpen((open) => !open);
      if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Automatically subscribe to the active task's detailed run stream when on the Task Detail page.
  useEffect(() => {
    const taskId = state.selectedId;
    const runId = state.activeRunId;
    if (view !== "task" || !taskId || !runId) {
      return;
    }
    setState((previous) => ({ ...previous, runEvents: [] }));
    const unsub = subscribeRunStream(readSessionToken(), taskId, runId, 0, (event) => {
      if (event.type === "text_delta") return;
      setState((previous) => {
        if (previous.selectedId !== taskId || previous.activeRunId !== runId) return previous;
        if (previous.runEvents.some((existing) => existing.seq === event.seq)) return previous;
        return { ...previous, runEvents: [...previous.runEvents, event].slice(-400) };
      });
    });
    return unsub;
  }, [view, state.selectedId, state.activeRunId]);

  const openTask = async (taskId: string) => {
    setView("task");
    setState((previous) => ({
      ...previous,
      selectedId: taskId,
      detail: previous.detail?.taskId === taskId ? previous.detail : null,
      activeRunId: null,
      runEvents: [],
    }));
    try {
      const [detail, events, proposalsRes, runsRes] = await Promise.all([
        api.getTask(taskId),
        api.taskEvents(taskId, 0),
        api.listProposals(taskId),
        api.taskRuns(taskId),
      ]);
      setState((previous) => ({
        ...previous,
        detail,
        events,
        proposals: proposalsRes.proposals,
        runIds: runsRes.runs,
        activeRunId: runsRes.runs[0] ?? null,
        error: null,
      }));
    } catch (error) {
      if (isNetworkError(error)) {
        setState((previous) => ({ ...previous, connection: "reconnecting" }));
      } else {
        setState((previous) => ({ ...previous, error: describe(error) }));
      }
    }
  };

  const focusMainChat = () => {
    setView("chat");
    window.setTimeout(() => document.getElementById("composer-input")?.focus(), 20);
  };

  const run = async (action: () => Promise<string | null | void>) => {
    try {
      const nextSelected = await action();
      await refresh(nextSelected === undefined ? undefined : nextSelected);
    } catch (error) {
      if (isNetworkError(error)) {
        setState((previous) => ({ ...previous, connection: "reconnecting" }));
      } else {
        setState((previous) => ({ ...previous, error: describe(error) }));
      }
    }
  };

  const handleSendChat = async (submission: ComposerSubmission) => {
    const tempUserId = `optimistic-user-${Date.now()}`;
    const nowIso = new Date().toISOString();
    const optimisticUser: ChatMessage = {
      messageId: tempUserId,
      role: "user",
      content: submission.text,
      taskId: null,
      executorId: submission.kind === "repo_delivery" ? submission.executorId : null,
      model: submission.kind === "repo_delivery" ? (submission.model ?? null) : null,
      status: "done",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    setState((previous) => ({
      ...previous,
      messages: [...previous.messages, optimisticUser],
      error: null,
    }));

    try {
      const res = await api.sendChat(
        submission.kind === "sse_log"
          ? { text: submission.text, mode: "sse_log" }
          : {
              text: submission.text,
              mode: "auto",
              executorId: submission.executorId,
              model: submission.model,
              sourcePath: submission.sourcePath,
              baseRef: submission.baseRef,
              checkCommand: submission.checkCommand,
              maxRepairRounds: state.settingsPayload?.settings.assistant.defaultMaxRepairRounds,
            },
      );
      setState((previous) => {
        const withoutTemp = previous.messages.filter((m) => m.messageId !== tempUserId);
        let next = upsertChatMessage(withoutTemp, res.userMessage);
        if (res.kind === "chat") {
          next = upsertChatMessage(next, res.assistantMessage);
        } else {
          next = upsertChatMessage(next, res.taskCardMessage);
        }
        return { ...previous, messages: next };
      });
      if (res.kind === "task") {
        void refresh(res.taskId);
      }
    } catch (error) {
      setState((previous) => ({
        ...previous,
        messages: previous.messages.filter((m) => m.messageId !== tempUserId),
        ...(isNetworkError(error) ? { connection: "reconnecting" as const } : { error: describe(error) }),
      }));
    }
  };

  const handleSelectExecutor = (executorId: string) => {
    hasManualExecRef.current = true;
    setSelectedExecutorId(executorId);
    try {
      window.localStorage.setItem("timo_selected_executor", executorId);
    } catch {
      // ignore storage restriction
    }
  };

  const handleSelectModel = (model: string) => {
    setSelectedModel(model);
    try {
      if (model) window.localStorage.setItem("timo_selected_model", model);
      else window.localStorage.removeItem("timo_selected_model");
    } catch {
      // ignore storage restriction
    }
  };

  // Sync default executor from settings ONLY when user hasn't picked one yet
  // OR when the user explicitly changes `defaultExecutor` in Settings.
  useEffect(() => {
    const def = state.settingsPayload?.settings.assistant.defaultExecutor;
    if (!def) return;
    if (lastSettingsDefaultRef.current === null) {
      lastSettingsDefaultRef.current = def;
      if (!hasManualExecRef.current) {
        setSelectedExecutorId(def);
      }
      return;
    }
    if (def !== lastSettingsDefaultRef.current) {
      lastSettingsDefaultRef.current = def;
      handleSelectExecutor(def);
      handleSelectModel("");
    }
  }, [state.settingsPayload?.settings.assistant.defaultExecutor]);

  // Fall back gracefully only if the currently selected executor is unavailable.
  useEffect(() => {
    const ready = state.executors.filter((e) => e.available);
    if (ready.length > 0 && !ready.some((e) => e.id === selectedExecutorId)) {
      const preferred =
        ready.find((e) => e.id === state.settingsPayload?.settings.assistant.defaultExecutor) ??
        ready.find((e) => e.id === "qwen-code") ??
        ready[0]!;
      setSelectedExecutorId(preferred.id);
    }
  }, [state.executors, selectedExecutorId]);

  const handleQuickPrompt = (text: string) => {
    const activeExec =
      selectedExecutorId ||
      state.settingsPayload?.settings.assistant.defaultExecutor ||
      state.executors.find((e) => e.available)?.id ||
      "qwen-code";
    void handleSendChat({
      kind: "repo_delivery",
      text,
      executorId: activeExec,
      ...(selectedModel ? { model: selectedModel } : {}),
    });
  };

  const handleRenameTask = async (taskId: string, title: string) => {
    await run(async () => {
      await api.updateTask(taskId, { title });
    });
  };

  const handleArchiveTask = async (taskId: string, archived: boolean) => {
    await run(async () => {
      await api.updateTask(taskId, { archived });
    });
  };

  const handleDeleteTask = async (taskId: string, force: boolean) => {
    const wasViewing = view === "task" && state.selectedId === taskId;
    await run(async () => {
      await api.deleteTask(taskId, force);
      if (wasViewing) {
        setView("chat");
        return null;
      }
      return undefined;
    });
  };

  const handleClearChat = async () => {
    await run(async () => {
      await api.clearChat();
      setState((previous) => ({ ...previous, messages: [] }));
    });
  };

  const handleRetryConnect = async () => {
    setRetrying(true);
    try {
      await refresh();
      await refreshProviders(false);
    } finally {
      setRetrying(false);
    }
  };

  const shellClass = leftOpen ? "shell" : "shell no-left";
  const isOffline = state.connection === "reconnecting" || state.connection === "closed";
  const streamingMsg = state.messages.find((m) => m.role === "assistant" && m.status === "streaming");

  return (
    <>
      <div className="topbar">
        <Topbar
          leftOpen={leftOpen}
          view={view}
          onToggleLeft={() => setLeftOpen((open) => !open)}
          onGoHome={focusMainChat}
          onBackFromSettings={() => setView(state.selectedId && state.detail ? "chat" : "chat")}
          onPalette={() => setPaletteOpen(true)}
        />
      </div>

      {view === "settings" ? (
        <SettingsView
          key={settingsSection}
          initialSection={settingsSection}
          payload={state.settingsPayload}
          skillsPayload={state.skillsPayload}
          executors={state.executors}
          executorProviders={state.executorProviders}
          policy={state.policy}
          metrics={state.metrics}
          defaultRepoPath={state.defaultRepoPath}
          theme={theme}
          onThemeChange={setTheme}
          onRefreshProviders={() => refreshProviders(true)}
          onRefreshSkills={async () => {
            const [sp, chatRes] = await Promise.all([api.getSkills(), api.getChat(200)]);
            setState((previous) => ({
              ...previous,
              skillsPayload: sp,
              contextSummary: chatRes.contextSummary ?? previous.contextSummary,
            }));
          }}
          onSaveSkill={async (input) => {
            await api.saveSkill(input);
            const [sp, chatRes] = await Promise.all([api.getSkills(), api.getChat(200)]);
            setState((previous) => ({
              ...previous,
              skillsPayload: sp,
              contextSummary: chatRes.contextSummary ?? previous.contextSummary,
            }));
          }}
          onUpdateSkill={async (id, patch) => {
            await api.updateSkill(id, patch);
            const [sp, chatRes] = await Promise.all([api.getSkills(), api.getChat(200)]);
            setState((previous) => ({
              ...previous,
              skillsPayload: sp,
              contextSummary: chatRes.contextSummary ?? previous.contextSummary,
            }));
          }}
          onDeleteSkill={async (id) => {
            await api.deleteSkill(id);
            const [sp, chatRes] = await Promise.all([api.getSkills(), api.getChat(200)]);
            setState((previous) => ({
              ...previous,
              skillsPayload: sp,
              contextSummary: chatRes.contextSummary ?? previous.contextSummary,
            }));
          }}
          onImportSkills={async (input) => {
            const res = await api.importSkills(input);
            const [sp, chatRes] = await Promise.all([api.getSkills(), api.getChat(200)]);
            setState((previous) => ({
              ...previous,
              skillsPayload: sp,
              contextSummary: chatRes.contextSummary ?? previous.contextSummary,
            }));
            return { imported: res.imported, skipped: res.skipped };
          }}
          onPickFolder={() => api.pickFolder()}
          onInspectFolder={(path) => api.inspectFolder(path)}
          onScanRoot={(path) => api.scanWorkspaceRoot(path)}
          onListWorkspaces={() => api.listWorkspaces()}
          onCleanupWorkspaces={(input) => api.cleanupWorkspaces(input)}
          onSaveSettings={async (next) => {
            const saved = await api.saveSettings(next);
            setState((previous) => ({ ...previous, settingsPayload: saved, error: null }));
          }}
          onSaveCredential={async (key, value) => {
            const res = await api.setCredential(key, value);
            setState((previous) => ({
              ...previous,
              settingsPayload: previous.settingsPayload
                ? { ...previous.settingsPayload, credentials: res.credentials }
                : previous.settingsPayload,
              error: null,
            }));
          }}
          onTestConnection={async (connectionId) => {
            const res = await api.testConnection(connectionId);
            return { ok: res.ok, message: res.message };
          }}
        />
      ) : (
        <div className={shellClass}>
          {leftOpen && (
            <aside className="sidebar">
              <Sidebar
                tasks={state.tasks}
                inbox={state.inbox}
                selectedTaskId={view === "task" ? state.selectedId : null}
                chatActive={view === "chat"}
                hasChatMessages={state.messages.length > 0}
                onFocusMainChat={focusMainChat}
                onClearChat={() => void handleClearChat()}
                onSelectTask={(taskId) => void openTask(taskId)}
                onRenameTask={(taskId, title) => void handleRenameTask(taskId, title)}
                onArchiveTask={(taskId, archived) => void handleArchiveTask(taskId, archived)}
                onDeleteTask={(taskId, force) => void handleDeleteTask(taskId, force)}
                onOpenSettings={() => setView("settings")}
              />
            </aside>
          )}
          <main className={view === "chat" && state.messages.length === 0 ? "center is-empty" : "center"}>
            {isOffline && (
              <div className="conn-bar" role="status">
                <span className="dot dot-warning dot-pulse" />
                <span>本地 Timo 服务已断开，正在自动重连…</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ marginLeft: "auto" }}
                  disabled={retrying}
                  onClick={() => void handleRetryConnect()}
                >
                  {retrying ? "连接中…" : "立即重试"}
                </button>
              </div>
            )}
            {state.error && (
              <div className="error-bar" role="alert">
                <span className="dot dot-error" />
                <span className="error-bar-text">{state.error}</span>
                <button
                  type="button"
                  className="icon-btn"
                  style={{ marginLeft: "auto", width: 22, height: 22 }}
                  title="关闭提示"
                  onClick={() => setState((previous) => ({ ...previous, error: null }))}
                >
                  ×
                </button>
              </div>
            )}
            {view === "task" ? (
              <TaskDetailView
                detail={state.detail}
                events={state.events}
                executors={state.executors}
                runIds={state.runIds}
                activeRunId={state.activeRunId}
                runEvents={state.runEvents}
                proposals={state.proposals}
                inbox={state.inbox}
                onBack={focusMainChat}
                onSelectRun={(runId) => setState((previous) => ({ ...previous, activeRunId: runId }))}
                onSteer={async (taskId, message) => {
                  const res = await api.steer(taskId, message);
                  return { accepted: res.accepted, reason: res.reason };
                }}
                onHandoff={(taskId, executorId) => run(async () => { await api.handoff(taskId, executorId); })}
                onReconcileOperation={(operationId) => run(async () => { await api.reconcileOperation(operationId); })}
                onResolveOperation={(operationId, resolution) => run(async () => { await api.resolveOperation(operationId, resolution); })}
                onStop={(taskId) => run(async () => { await api.stop(taskId); })}
                onRetry={(taskId) => run(async () => { await api.retry(taskId); })}
                onRenameTask={(taskId, title) => void handleRenameTask(taskId, title)}
                onArchiveTask={(taskId, archived) => void handleArchiveTask(taskId, archived)}
                onDeleteTask={(taskId, force) => void handleDeleteTask(taskId, force)}
                onProposeGoal={(taskId, goal) => run(async () => { await api.proposeGoal(taskId, goal); })}
                onConfirmProposal={(proposalId) => run(async () => { await api.confirmProposal(proposalId); })}
                onCancelProposal={(proposalId) => run(async () => { await api.cancelProposal(proposalId); })}
                onResolve={(taskId, action, approved) => run(async () => { await api.resolve(taskId, action, approved); })}
                onDismissInbox={(taskId, decisionKey) => run(async () => { await api.dismissInbox(taskId, decisionKey); })}
              />
            ) : (
              <>
                <Thread
                  messages={state.messages}
                  tasks={state.tasks}
                  inbox={state.inbox}
                  liveProgress={state.liveProgress}
                  onQuickPrompt={handleQuickPrompt}
                  onOpenTask={(taskId) => void openTask(taskId)}
                  onStopChat={(messageId) => void api.stopChat(messageId)}
                  onStopTask={(taskId) => run(async () => { await api.stop(taskId); })}
                  onRetryTask={(taskId) => run(async () => { await api.retry(taskId); })}
                  onResolveDecision={(taskId, action, approved) => run(async () => { await api.resolve(taskId, action, approved); })}
                  onDismissInbox={(taskId, decisionKey) => run(async () => { await api.dismissInbox(taskId, decisionKey); })}
                />
                <Composer
                  disabled={isOffline}
                  isStreaming={Boolean(streamingMsg)}
                  onStopStreaming={() => {
                    if (streamingMsg) void api.stopChat(streamingMsg.messageId);
                  }}
                  defaultRepoPath={state.defaultRepoPath}
                  executors={state.executors}
                  executorProviders={state.executorProviders}
                  settings={state.settingsPayload?.settings ?? null}
                  selectedExecutorId={selectedExecutorId}
                  selectedModel={selectedModel}
                  onSelectExecutor={handleSelectExecutor}
                  onSelectModel={handleSelectModel}
                  contextSummary={state.contextSummary}
                  skills={state.skillsPayload?.skills ?? []}
                  onOpenSettings={(sec) => {
                    setSettingsSection(sec ?? "assistant");
                    setView("settings");
                  }}
                  onSubmit={(submission) => void handleSendChat(submission)}
                />
              </>
            )}
          </main>
        </div>
      )}
      {paletteOpen && <Palette tasks={state.tasks} onSelect={(taskId) => void openTask(taskId)} onClose={() => setPaletteOpen(false)} />}
    </>
  );
}

function upsertChatMessage(list: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const idx = list.findIndex((m) => m.messageId === incoming.messageId);
  if (idx === -1) return [...list, incoming];
  const existing = list[idx]!;
  // Preserve live streamed content if incoming is older/shorter while still streaming.
  const content =
    incoming.status === "streaming" && existing.content.length > incoming.content.length
      ? existing.content
      : incoming.content;
  const next = [...list];
  next[idx] = { ...incoming, content };
  return next;
}

function mergeMessages(previous: ChatMessage[], server: ChatMessage[]): ChatMessage[] {
  const prevById = new Map(previous.map((m) => [m.messageId, m]));
  const merged = server.map((msg) => {
    const local = prevById.get(msg.messageId);
    if (local && msg.status === "streaming" && local.content.length > msg.content.length) {
      return { ...msg, content: local.content };
    }
    return msg;
  });
  for (const local of previous) {
    if (local.messageId.startsWith("optimistic-")) {
      merged.push(local);
    }
  }
  return merged;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
