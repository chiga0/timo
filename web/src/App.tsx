import { useEffect, useMemo, useRef, useState } from "react";
import { Api, ApiError, readSessionToken, subscribeEvents, type InboxItem, type PolicySnapshot, type Proposal, type TaskDetail, type TaskEvent, type TaskSummary } from "./api.js";
import { Composer } from "./components/Composer.js";
import { Inspector } from "./components/Inspector.js";
import { Palette } from "./components/Palette.js";
import { Sidebar } from "./components/Sidebar.js";
import { Thread } from "./components/Thread.js";
import { Topbar } from "./components/Topbar.js";

type Theme = "light" | "dark";

export interface WorkbenchState {
  tasks: TaskSummary[];
  inbox: InboxItem[];
  policy: PolicySnapshot | null;
  selectedId: string | null;
  detail: TaskDetail | null;
  events: TaskEvent[];
  proposals: Proposal[];
  connection: "open" | "reconnecting" | "closed";
  error: string | null;
}

export function App(): React.JSX.Element {
  const api = useMemo(() => new Api(readSessionToken()), []);
  const [theme, setTheme] = useState<Theme>("light");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tab, setTab] = useState<"thread" | "live">("thread");
  const [state, setState] = useState<WorkbenchState>({
    tasks: [],
    inbox: [],
    policy: null,
    selectedId: null,
    detail: null,
    events: [],
    proposals: [],
    connection: "closed",
    error: null,
  });
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = state.selectedId;

  const refresh = async (selectId?: string) => {
    try {
      const [tasks, inbox, policy] = await Promise.all([api.listTasks(), api.inbox(), api.policy()]);
      const nextId = selectId ?? selectedRef.current ?? tasks.tasks[0]?.taskId ?? null;
      const [detail, events, proposalsRes] = nextId
        ? await Promise.all([api.getTask(nextId), api.taskEvents(nextId, 0), api.listProposals(nextId)])
        : [null, [], { proposals: [] }];
      setState((previous) => ({
        ...previous,
        tasks: tasks.tasks,
        inbox: inbox.items,
        policy,
        selectedId: nextId,
        detail,
        events,
        proposals: proposalsRes.proposals,
        error: null,
      }));
    } catch (error) {
      setState((previous) => ({ ...previous, error: describe(error) }));
    }
  };

  useEffect(() => {
    void refresh();
    // The token may arrive as a cookie instead of a query parameter.
    fetch("/api/health", { headers: readSessionToken() ? { authorization: `Bearer ${readSessionToken()}` } : {} }).catch(() => undefined);
  }, []);

  // Live stream: the server replays from afterSeq first, so reconnects never
  // lose an event; a task-scoped reload keeps the detail view current.
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
      (connection) => setState((previous) => ({ ...previous, connection })),
    );
    return () => {
      if (reloadTimer !== null) window.clearTimeout(reloadTimer);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.documentElement.className = `theme-${theme}`;
  }, [theme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "[") setLeftOpen((open) => !open);
      if (event.key === "]") setRightOpen((open) => !open);
      if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const select = async (taskId: string) => {
    setState((previous) => ({ ...previous, selectedId: taskId }));
    try {
      const [detail, events, proposalsRes] = await Promise.all([
        api.getTask(taskId),
        api.taskEvents(taskId, 0),
        api.listProposals(taskId),
      ]);
      setState((previous) => ({ ...previous, detail, events, proposals: proposalsRes.proposals }));
    } catch (error) {
      setState((previous) => ({ ...previous, error: describe(error) }));
    }
  };

  const run = async (action: () => Promise<string | void>) => {
    try {
      const nextSelected = await action();
      await refresh(typeof nextSelected === "string" ? nextSelected : undefined);
    } catch (error) {
      setState((previous) => ({ ...previous, error: describe(error) }));
    }
  };

  const shellClass = ["shell", leftOpen ? "" : "no-left", rightOpen ? "" : "no-right"].filter(Boolean).join(" ");

  return (
    <>
      <div className="topbar">
        <Topbar
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          theme={theme}
          tab={tab}
          onToggleLeft={() => setLeftOpen((open) => !open)}
          onToggleRight={() => setRightOpen((open) => !open)}
          onTheme={setTheme}
          onTab={setTab}
          onPalette={() => setPaletteOpen(true)}
        />
      </div>
      <div className={shellClass}>
        {leftOpen && (
          <aside className="sidebar">
            <Sidebar
              tasks={state.tasks}
              inbox={state.inbox}
              policy={state.policy}
              selectedId={state.selectedId}
              onSelect={(taskId) => void select(taskId)}
            />
          </aside>
        )}
        <main className="center">
          {state.error && <div className="banner">{state.error}</div>}
          <Thread
            detail={state.detail}
            events={state.events}
            proposals={state.proposals}
            inbox={state.inbox}
            connection={state.connection}
            tab={tab}
            onResolve={(taskId, action, approved) => run(async () => { await api.resolve(taskId, action, approved); })}
            onConfirmProposal={(proposalId) => run(async () => { await api.confirmProposal(proposalId); })}
            onCancelProposal={(proposalId) => run(async () => { await api.cancelProposal(proposalId); })}
          />
          <Composer
            disabled={false}
            onSubmit={(text) =>
              run(async () => {
                const legal = text.trim();
                if (legal === "") return;
                const requestId = `web-${Date.now()}`;
                const log = btoa(new TextEncoder().encode(legal).reduce((acc, byte) => acc + String.fromCharCode(byte), ""));
                const created = await api.createTask(requestId, log);
                return created.taskId;
              })
            }
          />
        </main>
        {rightOpen && (
          <aside className="inspector">
            <Inspector
              detail={state.detail}
              events={state.events}
              proposals={state.proposals}
              onStop={(taskId) => run(async () => { await api.stop(taskId); })}
              onProposeGoal={(taskId, goal) => run(async () => { await api.proposeGoal(taskId, goal); })}
              onConfirmProposal={(proposalId) => run(async () => { await api.confirmProposal(proposalId); })}
              onCancelProposal={(proposalId) => run(async () => { await api.cancelProposal(proposalId); })}
              onResolve={(taskId, action, approved) => run(async () => { await api.resolve(taskId, action, approved); })}
              inbox={state.inbox}
            />
          </aside>
        )}
      </div>
      {paletteOpen && <Palette tasks={state.tasks} onSelect={(taskId) => void select(taskId)} onClose={() => setPaletteOpen(false)} />}
    </>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
