import { useEffect, useState } from "react";
import type {
  ConnectionKind,
  CredentialStatus,
  EfficiencyMetricsSnapshot,
  ExecutorDescriptor,
  ExecutorProviderCatalog,
  InspectedFolder,
  ManagedWorktree,
  PlatformConnectionConfig,
  PolicyRuleItem,
  PolicySnapshot,
  SettingsPayload,
  TimoUserSettings,
  WorkspaceFolderConfig,
} from "../api.js";
import { AgentLogo, agentLabel } from "./AgentIcons.js";

type SettingsSection = "assistant" | "folders" | "connections" | "appearance" | "system";
export type ThemePreference = "light" | "dark" | "system";

const CONNECTION_KIND_LABEL: Record<ConnectionKind, string> = {
  enterprise_git: "企业内部 Git 平台",
  github: "GitHub",
  gitlab: "GitLab",
  log_service: "日志查询服务",
  service_registry: "业务服务 / 环境入口",
};

const EMPTY_SETTINGS: TimoUserSettings = {
  version: 1,
  assistant: {
    defaultExecutor: "qwen-code",
    executorModels: {},
    systemPrompt: "",
    defaultMaxRepairRounds: 2,
  },
  defaultProjectId: null,
  defaultFolderId: null,
  folders: [],
  projects: [],
  knowledge: [],
  connections: [],
};

export function SettingsView(props: {
  payload: SettingsPayload | null;
  executors: ExecutorDescriptor[];
  executorProviders: Record<string, ExecutorProviderCatalog>;
  policy: PolicySnapshot | null;
  metrics: EfficiencyMetricsSnapshot | null;
  defaultRepoPath: string;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onRefreshProviders: () => Promise<void>;
  onPickFolder: () => Promise<{ cancelled: boolean; folder?: InspectedFolder; error?: string }>;
  onInspectFolder: (path: string) => Promise<{ folder: InspectedFolder }>;
  onScanRoot: (path?: string) => Promise<{ cancelled: boolean; rootPath?: string; folders: InspectedFolder[]; error?: string }>;
  onListWorkspaces: () => Promise<{ worktrees: ManagedWorktree[] }>;
  onCleanupWorkspaces: (input?: { taskId?: string; generation?: number; force?: boolean }) => Promise<{ removed: number; skipped: number }>;
  onSaveSettings: (next: TimoUserSettings) => Promise<void>;
  onSaveCredential: (key: string, value: string) => Promise<void>;
  onTestConnection: (connectionId: string) => Promise<{ ok: boolean; message: string }>;
}): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>("assistant");
  const [draft, setDraft] = useState<TimoUserSettings>(props.payload?.settings ?? EMPTY_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [showManualFolder, setShowManualFolder] = useState(false);
  const [manualFolderPath, setManualFolderPath] = useState("");
  const [worktrees, setWorktrees] = useState<ManagedWorktree[]>([]);
  const [loadingWorktrees, setLoadingWorktrees] = useState(false);
  const [refreshingProviders, setRefreshingProviders] = useState(false);
  const [activeProviderByExec, setActiveProviderByExec] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Add platform / service connection form state
  const [newConnName, setNewConnName] = useState("");
  const [newConnKind, setNewConnKind] = useState<ConnectionKind>("enterprise_git");
  const [newConnUrl, setNewConnUrl] = useState("");
  const [newConnApiPath, setNewConnApiPath] = useState("/api/v4");
  const [newConnAuthHeader, setNewConnAuthHeader] = useState("PRIVATE-TOKEN");
  const [newConnCredKey, setNewConnCredKey] = useState("ENTERPRISE_GIT_TOKEN");
  const [newConnNotes, setNewConnNotes] = useState("");
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  // Credential vault inputs (cleared immediately after save; never persisted in React state)
  const [credInputs, setCredInputs] = useState<Record<string, string>>({});
  const [customCredKey, setCustomCredKey] = useState("");
  const [customCredVal, setCustomCredVal] = useState("");

  useEffect(() => {
    if (props.payload?.settings) {
      setDraft(props.payload.settings);
    }
  }, [props.payload?.settings]);

  const loadWorktrees = async () => {
    setLoadingWorktrees(true);
    try {
      const res = await props.onListWorkspaces();
      setWorktrees(res.worktrees ?? []);
    } catch {
      // ignore if older server
    } finally {
      setLoadingWorktrees(false);
    }
  };

  useEffect(() => {
    if (section === "folders") {
      void loadWorktrees();
    }
  }, [section]);

  const formatError = (err: unknown): string => {
    const raw = err instanceof Error ? err.message : String(err);
    if (/404|not_found|no route/i.test(raw)) {
      return `操作失败（${raw}）：检测到当前后台运行的是旧版 timo serve 进程，请先在终端 Ctrl+C 重启 timo serve 后刷新页面。`;
    }
    return `操作失败：${raw}`;
  };

  const persist = async (next: TimoUserSettings, msg = "设置已保存到 ~/.timo/settings.json"): Promise<boolean> => {
    setSaving(true);
    setNotice(null);
    setErrorMsg(null);
    try {
      await props.onSaveSettings(next);
      setNotice(msg);
      return true;
    } catch (err) {
      setErrorMsg(formatError(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addInspectedFolder = async (folder: InspectedFolder) => {
    if (!folder.exists || !folder.isDirectory) {
      setErrorMsg(`目录不存在或不是有效文件夹：${folder.path}`);
      return;
    }
    const existing = draft.folders ?? [];
    if (existing.some((f) => f.path.replace(/\/+$/, "") === folder.path.replace(/\/+$/, ""))) {
      setNotice(`目录 ${folder.name} 已在列表中`);
      return;
    }
    const item: WorkspaceFolderConfig = {
      id: folder.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || `dir-${Date.now()}`,
      name: folder.name,
      path: folder.path,
      kind: folder.kind,
      ...(folder.baseRef ? { baseRef: folder.baseRef } : {}),
      ...(folder.detectedCheckCommand ? { checkCommand: folder.detectedCheckCommand } : {}),
      ...(folder.remoteHost ? { remoteHost: folder.remoteHost } : {}),
      ...(folder.remoteRepo ? { remoteRepo: folder.remoteRepo } : {}),
    };
    const nextFolders = [...existing, item];
    await persist({ ...draft, folders: nextFolders }, `已添加目录 ${folder.name}`);
  };

  const handleScanRoot = async () => {
    setPickingFolder(true);
    setNotice(null);
    setErrorMsg(null);
    try {
      const res = await props.onScanRoot();
      if (res.error) {
        setErrorMsg(res.error);
        return;
      }
      if (res.cancelled) return;
      if (res.folders.length === 0) {
        setNotice(`在 ${res.rootPath ?? "该目录"} 下未发现新的 Git 仓库`);
        return;
      }
      const existing = draft.folders ?? [];
      const existingPaths = new Set(existing.map((f) => f.path.replace(/\/+$/, "")));
      const added: WorkspaceFolderConfig[] = [];
      for (const f of res.folders) {
        const cleanPath = f.path.replace(/\/+$/, "");
        if (existingPaths.has(cleanPath)) continue;
        existingPaths.add(cleanPath);
        added.push({
          id: f.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || `dir-${Date.now()}-${added.length}`,
          name: f.name,
          path: cleanPath,
          kind: f.kind,
          ...(f.baseRef ? { baseRef: f.baseRef } : {}),
          ...(f.detectedCheckCommand ? { checkCommand: f.detectedCheckCommand } : {}),
          ...(f.remoteHost ? { remoteHost: f.remoteHost } : {}),
          ...(f.remoteRepo ? { remoteRepo: f.remoteRepo } : {}),
        });
      }
      if (added.length === 0) {
        setNotice(`扫描到 ${res.folders.length} 个目录，均已在工作区中`);
        return;
      }
      await persist({ ...draft, folders: [...existing, ...added] }, `Timo 已自动扫描并加入 ${added.length} 个目录`);
    } catch (err) {
      setErrorMsg(formatError(err));
    } finally {
      setPickingFolder(false);
    }
  };

  const handlePickFolder = async () => {
    setPickingFolder(true);
    setNotice(null);
    setErrorMsg(null);
    try {
      const res = await props.onPickFolder();
      if (res.error) {
        setErrorMsg(res.error);
        setShowManualFolder(true);
        return;
      }
      if (res.cancelled || !res.folder) return;
      await addInspectedFolder(res.folder);
    } catch (err) {
      setErrorMsg(formatError(err));
      setShowManualFolder(true);
    } finally {
      setPickingFolder(false);
    }
  };

  const handleManualAddFolder = async () => {
    const raw = manualFolderPath.trim();
    if (!raw) return;
    setPickingFolder(true);
    setNotice(null);
    setErrorMsg(null);
    try {
      const res = await props.onInspectFolder(raw);
      await addInspectedFolder(res.folder);
      setManualFolderPath("");
      setShowManualFolder(false);
    } catch (err) {
      setErrorMsg(formatError(err));
    } finally {
      setPickingFolder(false);
    }
  };

  const saveCredential = async (key: string, value: string, msg: string) => {
    setNotice(null);
    setErrorMsg(null);
    try {
      await props.onSaveCredential(key, value);
      setNotice(msg);
    } catch (err) {
      setErrorMsg(formatError(err));
    }
  };

  const executorIds =
    props.executors.length > 0 ? props.executors.map((e) => e.id) : ["qwen-code", "pi", "codex", "opencode"];
  const folders = draft.folders ?? [];
  const folderMeta = props.payload?.folderMeta ?? {};
  const localAuth = props.payload?.localAuth;
  const credentials: CredentialStatus[] = props.payload?.credentials ?? [];

  const navGroups: Array<{ label: string; items: Array<[SettingsSection, string]> }> = [
    {
      label: "通用",
      items: [["appearance", "外观"]],
    },
    {
      label: "开发",
      items: [
        ["assistant", "主助手与代理"],
        ["folders", `工作区 (${folders.length})`],
        ["connections", "平台与凭证"],
      ],
    },
    {
      label: "系统",
      items: [["system", "安全护栏与状态"]],
    },
  ];

  return (
    <div className="settings-shell">
      <nav className="settings-nav">
        {navGroups.map((group) => (
          <div key={group.label} style={{ marginBottom: 12 }}>
            <div className="group-label">{group.label}</div>
            <div className="nav-list">
              {group.items.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={section === id ? "nav-item active" : "nav-item"}
                  onClick={() => {
                    setSection(id);
                    setNotice(null);
                    setErrorMsg(null);
                  }}
                >
                  <span className="t">{label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="settings-body">
        <div className="settings-inner stack">
          {errorMsg && <div className="banner banner-error" style={{ margin: 0 }}>{errorMsg}</div>}
          {notice && <div className="banner" style={{ margin: 0 }}>{notice}</div>}

          {section === "assistant" && (
            <>
              <header className="settings-head">
                <h2>主助手与执行器</h2>
                <p className="muted">设置默认代理、各代理的默认模型覆写，以及派发任务时统一附带的团队规范与自定义提示词。</p>
              </header>

              <section className="card">
                <header className="card-head">默认执行策略</header>
                <div className="card-body stack">
                  <div className="stack" style={{ gap: 8 }}>
                    <span className="field-label">默认代理</span>
                    <div className="agent-grid-4">
                      {executorIds.map((id) => (
                        <button
                          key={id}
                          type="button"
                          className={draft.assistant.defaultExecutor === id ? "agent-option active" : "agent-option"}
                          onClick={() =>
                            setDraft({ ...draft, assistant: { ...draft.assistant, defaultExecutor: id } })
                          }
                        >
                          <AgentLogo id={id} size={16} />
                          <span>{agentLabel(id)}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {(() => {
                    const activeId = draft.assistant.defaultExecutor;
                    const catalog = props.executorProviders[activeId];
                    const providers = catalog?.providers ?? [];
                    const selectedProviderId = activeProviderByExec[activeId] ?? providers[0]?.id ?? "";
                    const activeProvider = providers.find((p) => p.id === selectedProviderId) ?? providers[0];
                    const selectedModel = draft.assistant.executorModels[activeId] ?? "";
                    return (
                      <div className="card-box stack" style={{ gap: 8 }}>
                        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                          <AgentLogo id={activeId} size={14} />
                          <strong>{agentLabel(activeId)} 已配置的 Provider</strong>
                          {catalog?.defaultModel && (
                            <span className="badge-pill mono">
                              CLI 默认：{catalog.defaultProvider ? `${catalog.defaultProvider}/` : ""}{catalog.defaultModel}
                            </span>
                          )}
                          <button
                            type="button"
                            className="btn-link"
                            style={{ marginLeft: "auto" }}
                            disabled={refreshingProviders}
                            onClick={() => {
                              setRefreshingProviders(true);
                              void props.onRefreshProviders().finally(() => setRefreshingProviders(false));
                            }}
                          >
                            {refreshingProviders ? "探测中…" : "刷新探测"}
                          </button>
                        </div>
                        {providers.length === 0 ? (
                          <div className="muted small">
                            未探测到 {agentLabel(activeId)} 的本地 Provider 列表（请确认该 CLI 已登录配置，或已重启新版 timo serve）。
                          </div>
                        ) : (
                          <>
                            <div className="provider-pills">
                              {providers.map((prov) => (
                                <button
                                  key={prov.id}
                                  type="button"
                                  className={activeProvider?.id === prov.id ? "provider-pill active" : "provider-pill"}
                                  onClick={() => setActiveProviderByExec((prev) => ({ ...prev, [activeId]: prov.id }))}
                                >
                                  <span className="mono">{prov.name}</span>
                                  <span className="muted mono" style={{ fontSize: 10 }}>{prov.models.length}</span>
                                </button>
                              ))}
                            </div>
                            {activeProvider && activeProvider.models.length > 0 && (
                              <div className="model-pills">
                                {activeProvider.models.slice(0, 24).map((m) => (
                                  <button
                                    key={m.id}
                                    type="button"
                                    className={selectedModel === m.id ? "model-pill active mono" : "model-pill mono"}
                                    title={m.id}
                                    onClick={() => {
                                      const nextModels = { ...draft.assistant.executorModels };
                                      if (selectedModel === m.id) delete nextModels[activeId];
                                      else nextModels[activeId] = m.id;
                                      setDraft({ ...draft, assistant: { ...draft.assistant, executorModels: nextModels } });
                                    }}
                                  >
                                    {m.label}
                                  </button>
                                ))}
                                {activeProvider.models.length > 24 && (
                                  <span className="muted small" style={{ alignSelf: "center" }}>
                                    +{activeProvider.models.length - 24} 个模型可在下方下拉选择
                                  </span>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })()}

                  <div className="stack" style={{ gap: 8 }}>
                    <span className="field-label">各代理默认模型（点击上方模型或从已探测列表选择，留空则用 CLI 自身默认）</span>
                    <div className="form-grid2">
                      {executorIds.map((id) => {
                        const catalog = props.executorProviders[id];
                        const allModels = (catalog?.providers ?? []).flatMap((p) => p.models);
                        const listId = `models-list-${id}`;
                        const placeholder = catalog?.defaultModel
                          ? `CLI 默认：${catalog.defaultModel}`
                          : "留空使用 CLI 默认模型";
                        return (
                          <label key={id} className="field">
                            <span className="field-label row" style={{ gap: 6 }}>
                              <AgentLogo id={id} size={13} />
                              <span>{agentLabel(id)}</span>
                              {catalog && catalog.providers.length > 0 && (
                                <span className="muted" style={{ marginLeft: "auto", fontSize: 10.5 }}>
                                  {catalog.providers.length} Provider · {allModels.length} 模型
                                </span>
                              )}
                            </span>
                            <input
                              list={allModels.length > 0 ? listId : undefined}
                              className="input mono"
                              placeholder={placeholder}
                              value={draft.assistant.executorModels[id] ?? ""}
                              onChange={(e) => {
                                const nextModels = { ...draft.assistant.executorModels };
                                if (e.target.value.trim()) nextModels[id] = e.target.value;
                                else delete nextModels[id];
                                setDraft({ ...draft, assistant: { ...draft.assistant, executorModels: nextModels } });
                              }}
                            />
                            {allModels.length > 0 && (
                              <datalist id={listId}>
                                {allModels.map((m) => (
                                  <option key={m.id} value={m.id}>{m.label}</option>
                                ))}
                              </datalist>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <label className="field" style={{ maxWidth: 220 }}>
                    <span className="field-label">验收失败自动修复轮次</span>
                    <input
                      type="number"
                      min={0}
                      max={6}
                      className="input mono"
                      value={draft.assistant.defaultMaxRepairRounds}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          assistant: { ...draft.assistant, defaultMaxRepairRounds: Math.max(0, Math.min(6, Number(e.target.value) || 0)) },
                        })
                      }
                    />
                  </label>

                  <label className="field">
                    <span className="field-label">全局自定义提示词（System Prompt / 研发规范）</span>
                    <textarea
                      className="textarea"
                      rows={5}
                      placeholder="例如：始终用中文汇报；修改前先阅读仓库 AGENTS.md；补齐单元测试且禁止改动无关文件。"
                      value={draft.assistant.systemPrompt}
                      onChange={(e) =>
                        setDraft({ ...draft, assistant: { ...draft.assistant, systemPrompt: e.target.value } })
                      }
                    />
                  </label>

                  <div className="row">
                    <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void persist(draft)}>
                      {saving ? "保存中…" : "保存主助手配置"}
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}

          {section === "folders" && (
            <>
              <header className="settings-head">
                <h2>工作区</h2>
                <p className="muted">
                  工作区内所有目录地位平等、无主从之分——每个目录都可能被修改或查阅。你可以手动加入、让 Timo 扫描父目录自动发现，或通过下方目录规则让 Timo 按需自主纳入并全权托管 Worktree。
                </p>
              </header>

              <div className="folder-list">
                {folders.map((folder) => {
                  const meta = folderMeta[folder.id];
                  const missing = meta && !meta.exists;
                  return (
                    <div key={folder.id} className="folder-row" title={folder.path}>
                      <div className="folder-row-info">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ flexShrink: 0, color: "var(--muted)" }} aria-hidden="true">
                          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                        </svg>
                        <span className="folder-name">{folder.name}</span>
                        {missing && <span className="badge-pill" style={{ color: "var(--warning)" }}>路径不存在</span>}
                      </div>

                      <button
                        type="button"
                        className="folder-rm-btn"
                        title={`移除 ${folder.name}`}
                        onClick={() => {
                          const remaining = folders.filter((f) => f.id !== folder.id);
                          void persist({ ...draft, folders: remaining }, `已移除目录 ${folder.name}`);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}

                <div className="row" style={{ borderTop: folders.length > 0 ? "1px solid var(--border)" : "0", gap: 0 }}>
                  <button
                    type="button"
                    className="folder-add-row"
                    style={{ flex: 1 }}
                    disabled={pickingFolder || saving}
                    onClick={() => void handlePickFolder()}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ color: "var(--muted)" }} aria-hidden="true">
                      <path d="M12 10v6M9 13h6" />
                      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                    </svg>
                    <span>{pickingFolder ? "正在打开目录选择器…" : "添加文件夹"}</span>
                  </button>
                  <button
                    type="button"
                    className="folder-add-row"
                    style={{ width: "auto", borderLeft: "1px solid var(--border)", color: "var(--muted)", fontSize: 12 }}
                    disabled={pickingFolder || saving}
                    onClick={() => void handleScanRoot()}
                    title="选择一个父目录（如 codebase），由 Timo 自动扫描发现其中的仓库"
                  >
                    <span>✦ 扫描父目录自动纳入</span>
                  </button>
                </div>
              </div>

              <div className="row" style={{ gap: 8 }}>
                {!showManualFolder ? (
                  <button type="button" className="btn-link" onClick={() => setShowManualFolder(true)}>
                    或手动输入目录路径
                  </button>
                ) : (
                  <div className="row" style={{ width: "100%", gap: 8 }}>
                    <input
                      className="input mono"
                      style={{ flex: 1 }}
                      placeholder="/Users/you/codebase/my-folder"
                      value={manualFolderPath}
                      onChange={(e) => setManualFolderPath(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && manualFolderPath.trim()) {
                          e.preventDefault();
                          void handleManualAddFolder();
                        }
                      }}
                    />
                    <button type="button" className="btn btn-primary btn-sm" disabled={!manualFolderPath.trim() || pickingFolder} onClick={() => void handleManualAddFolder()}>
                      添加
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setShowManualFolder(false)}>
                      取消
                    </button>
                  </div>
                )}
              </div>

              <section className="card">
                <header className="card-head">交给 Timo 的目录与操作规则</header>
                <div className="card-body stack">
                  <textarea
                    className="textarea"
                    rows={4}
                    placeholder="例如：我的代码都在 ~/Documents/codebase 下，遇到跨服务需求时自动把关联仓库纳入工作区；runbook 目录只读不改；改完代码自动跑单测并等待我确认后再推送。"
                    value={draft.workspaceRules ?? ""}
                    onChange={(e) => setDraft({ ...draft, workspaceRules: e.target.value })}
                  />
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={saving}
                      onClick={() => void persist(draft, "目录规则已保存，Timo 派发任务时会自动遵循")}
                    >
                      保存目录规则
                    </button>
                  </div>
                </div>
              </section>

              <section className="card">
                <header className="card-head">
                  <span>Timo 托管的 Worktree（{worktrees.length}）</span>
                  <div className="row" style={{ gap: 8 }}>
                    <button type="button" className="btn-link" disabled={loadingWorktrees} onClick={() => void loadWorktrees()}>
                      {loadingWorktrees ? "刷新中…" : "刷新"}
                    </button>
                    {worktrees.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          void props.onCleanupWorkspaces().then(
                            (res) => {
                              setNotice(`已清理 ${res.removed} 个已结束 Worktree${res.skipped > 0 ? `（保留 ${res.skipped} 个进行中或未提交目录）` : ""}`);
                              void loadWorktrees();
                            },
                            (err) => setErrorMsg(formatError(err)),
                          );
                        }}
                      >
                        回收已结束 Worktree
                      </button>
                    )}
                  </div>
                </header>
                <div className="card-body stack small">
                  <div className="muted">
                    所有代码修改都在 Timo 管理的独立隔离 Worktree 中完成，绝不污染你本机原目录。
                  </div>
                  {worktrees.length === 0 ? (
                    <div className="empty-box">当前没有残留的 Worktree</div>
                  ) : (
                    worktrees.map((ws) => (
                      <div key={`${ws.taskId}:g${ws.generation}`} className="card-box stack" style={{ gap: 4 }}>
                        <div className="row" style={{ flexWrap: "wrap" }}>
                          <strong>{ws.taskTitle}</strong>
                          <span className="badge-pill mono">g{ws.generation}</span>
                          <span className="badge-pill">{ws.taskStatus}</span>
                          <button
                            type="button"
                            className="btn-link"
                            style={{ marginLeft: "auto", color: "var(--error)" }}
                            onClick={() => {
                              void props.onCleanupWorkspaces({ taskId: ws.taskId, generation: ws.generation, force: true }).then(
                                () => {
                                  setNotice(`已回收 ${ws.taskTitle} (g${ws.generation}) 的 Worktree`);
                                  void loadWorktrees();
                                },
                                (err) => setErrorMsg(formatError(err)),
                              );
                            }}
                          >
                            回收
                          </button>
                        </div>
                        {ws.repos.map((r) => (
                          <div key={r.name} className="mono muted" style={{ fontSize: 11 }}>
                            {r.name} · {r.branch} · {r.headSha ? r.headSha.slice(0, 8) : r.baseSha.slice(0, 8)}
                            {r.dirty ? " · 有未提交改动" : ""}
                          </div>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </section>
            </>
          )}

          {section === "connections" && (
            <>
              <header className="settings-head">
                <h2>平台与凭证</h2>
                <p className="muted">
                  日常代码开发与 Git 操作会直接复用本机已认证的 Git / SSH / 钥匙串，无需重复配置。仅在需要 Timo 自动调平台 API 提 MR、查 CI 或外部日志时按需补充。
                </p>
              </header>

              <section className="card">
                <header className="card-head">
                  <span>本机已就绪的认证（自动复用）</span>
                </header>
                <div className="card-body stack small">
                  <div className="row">
                    <span className={localAuth?.gitAvailable ? "dot dot-success" : "dot dot-warning"} />
                    <span>本机 Git</span>
                    <span className="muted" style={{ marginLeft: "auto" }}>
                      {localAuth?.gitAvailable
                        ? [
                            localAuth.sshKeysCount > 0 ? `${localAuth.sshKeysCount} 把 SSH 密钥` : "",
                            localAuth.gitCredentialHelper ? `凭据助手：${localAuth.gitCredentialHelper}` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ") || "已就绪"
                        : "未检测到 git"}
                    </span>
                  </div>
                  <div className="row">
                    <span className={localAuth?.ghLoggedIn ? "dot dot-success" : "dot"} />
                    <span>GitHub CLI (gh)</span>
                    <span className="muted" style={{ marginLeft: "auto" }}>
                      {localAuth?.ghLoggedIn ? `已登录 · ${localAuth.ghSummary ?? "github.com"}` : "未登录（非必需）"}
                    </span>
                  </div>
                  {localAuth && localAuth.detectedRemoteHosts.length > 0 && (
                    <div className="row" style={{ flexWrap: "wrap", paddingTop: 6, borderTop: "1px solid var(--border)" }}>
                      <span className="muted">已从工作区识别到的代码主机：</span>
                      {localAuth.detectedRemoteHosts.map((host) => (
                        <span key={host} className="badge-pill mono">{host}</span>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {draft.connections.length > 0 && (
                <section className="card">
                  <header className="card-head">已手动配置的平台 API 与服务</header>
                  <div className="card-body stack">
                    {draft.connections.map((conn) => {
                      const cred = credentials.find((c) => c.key === conn.credentialKey);
                      const probe = testResults[conn.id];
                      return (
                        <div key={conn.id} className="card-box stack" style={{ gap: 6 }}>
                          <div className="row" style={{ flexWrap: "wrap" }}>
                            <span className={cred?.configured ? "dot dot-success" : "dot dot-warning"} />
                            <strong>{conn.name}</strong>
                            <span className="badge-pill">{CONNECTION_KIND_LABEL[conn.kind] ?? conn.kind}</span>
                            <span className="muted small" style={{ marginLeft: "auto" }}>
                              凭证 {conn.credentialKey}：{cred?.configured ? `已配置 (${cred.source})` : "未配置"}
                            </span>
                          </div>
                          <div className="mono small">{conn.baseUrl}{conn.apiPath ? ` · API ${conn.apiPath}` : ""}{conn.authHeader ? ` · Header ${conn.authHeader}` : ""}</div>
                          {conn.notes && <div className="small muted">{conn.notes}</div>}
                          {probe && (
                            <div className="small" style={{ color: probe.ok ? "var(--success)" : "var(--warning)" }}>
                              {probe.message}
                            </div>
                          )}
                          <div className="row" style={{ gap: 8 }}>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                setTestResults((prev) => ({ ...prev, [conn.id]: { ok: true, message: "正在检测…" } }));
                                void props.onTestConnection(conn.id).then(
                                  (res) => setTestResults((prev) => ({ ...prev, [conn.id]: res })),
                                  (err) => setTestResults((prev) => ({ ...prev, [conn.id]: { ok: false, message: formatError(err) } })),
                                );
                              }}
                            >
                              测试连通性
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              onClick={() => {
                                const next = { ...draft, connections: draft.connections.filter((c) => c.id !== conn.id) };
                                void persist(next, `已移除平台 ${conn.name}`);
                              }}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              <details className="ins-more">
                <summary className="ins-more-summary">高级：手动添加平台 REST API / 外部日志服务（可选）</summary>
                <div className="stack" style={{ marginTop: 10 }}>
                  <section className="card">
                    <header className="card-head">添加代码平台 API 或外部服务</header>
                    <div className="card-body stack">
                      <div className="form-grid2">
                        <label className="field">
                          <span className="field-label">平台名称</span>
                          <input className="input" placeholder="例如：企业代码平台" value={newConnName} onChange={(e) => setNewConnName(e.target.value)} />
                        </label>
                        <label className="field">
                          <span className="field-label">类型</span>
                          <select
                            className="input"
                            value={newConnKind}
                            onChange={(e) => {
                              const nextKind = e.target.value as ConnectionKind;
                              setNewConnKind(nextKind);
                              if (nextKind === "github") {
                                setNewConnCredKey("GH_TOKEN");
                                setNewConnAuthHeader("Authorization");
                                setNewConnApiPath("");
                              } else if (nextKind === "enterprise_git" || nextKind === "gitlab") {
                                setNewConnCredKey("ENTERPRISE_GIT_TOKEN");
                                setNewConnAuthHeader("PRIVATE-TOKEN");
                                setNewConnApiPath("/api/v4");
                              }
                            }}
                          >
                            <option value="enterprise_git">企业内部 Git 平台（REST API）</option>
                            <option value="gitlab">GitLab</option>
                            <option value="github">GitHub</option>
                            <option value="log_service">日志查询服务</option>
                            <option value="service_registry">业务服务 / 环境入口</option>
                          </select>
                        </label>
                        <label className="field" style={{ gridColumn: "1 / -1" }}>
                          <span className="field-label">平台地址（Base URL）</span>
                          <input className="input mono" placeholder="https://code.example.com" value={newConnUrl} onChange={(e) => setNewConnUrl(e.target.value)} />
                        </label>
                        {(newConnKind === "enterprise_git" || newConnKind === "gitlab") && (
                          <>
                            <label className="field">
                              <span className="field-label">REST API 前缀</span>
                              <input className="input mono" placeholder="/api/v4 或 /api/v3" value={newConnApiPath} onChange={(e) => setNewConnApiPath(e.target.value)} />
                            </label>
                            <label className="field">
                              <span className="field-label">认证请求头</span>
                              <input className="input mono" placeholder="PRIVATE-TOKEN 或 Authorization" value={newConnAuthHeader} onChange={(e) => setNewConnAuthHeader(e.target.value)} />
                            </label>
                          </>
                        )}
                        <label className="field">
                          <span className="field-label">凭证键名</span>
                          <input className="input mono" placeholder="ENTERPRISE_GIT_TOKEN" value={newConnCredKey} onChange={(e) => setNewConnCredKey(e.target.value)} />
                        </label>
                        <label className="field">
                          <span className="field-label">备注（可选）</span>
                          <input className="input" placeholder="例如：仅内网可达" value={newConnNotes} onChange={(e) => setNewConnNotes(e.target.value)} />
                        </label>
                      </div>
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={saving || !newConnUrl.trim()}
                          onClick={() => {
                            const baseUrl = newConnUrl.trim().replace(/\/+$/, "");
                            const name = newConnName.trim() || baseUrl;
                            const item: PlatformConnectionConfig = {
                              id: name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"),
                              name,
                              kind: newConnKind,
                              baseUrl,
                              credentialKey: newConnCredKey.trim() || "ENTERPRISE_GIT_TOKEN",
                              ...(newConnApiPath.trim() ? { apiPath: newConnApiPath.trim() } : {}),
                              ...(newConnAuthHeader.trim() ? { authHeader: newConnAuthHeader.trim() } : {}),
                              ...(newConnNotes.trim() ? { notes: newConnNotes.trim() } : {}),
                            };
                            void persist({ ...draft, connections: [...draft.connections, item] }, `已添加平台 ${name}`).then((ok) => {
                              if (!ok) return;
                              setNewConnName("");
                              setNewConnUrl("");
                              setNewConnNotes("");
                            });
                          }}
                        >
                          添加平台
                        </button>
                      </div>
                    </div>
                  </section>

                  <section className="card">
                    <header className="card-head">
                      <span>凭证保险箱（~/.timo/credentials.json · 0600 · 仅本地 Gateway 可读）</span>
                    </header>
                    <div className="card-body stack">
                      {credentials.map((cred) => (
                        <div key={cred.key} className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                          <span className={cred.configured ? "dot dot-success" : "dot"} />
                          <span className="mono" style={{ minWidth: 180 }}>{cred.key}</span>
                          <span className="muted small" style={{ minWidth: 100 }}>
                            {cred.configured ? (cred.source === "env" ? "环境变量已配置" : "已安全存储") : "未配置"}
                          </span>
                          <input
                            type="password"
                            className="input mono"
                            style={{ flex: "1 1 180px" }}
                            placeholder="输入新 Token 覆盖写入（保存后清空）"
                            value={credInputs[cred.key] ?? ""}
                            onChange={(e) => setCredInputs((prev) => ({ ...prev, [cred.key]: e.target.value }))}
                          />
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={!(credInputs[cred.key] ?? "").trim()}
                            onClick={() => {
                              const val = (credInputs[cred.key] ?? "").trim();
                              setCredInputs((prev) => ({ ...prev, [cred.key]: "" }));
                              void saveCredential(cred.key, val, `凭证 ${cred.key} 已安全保存（0600）`);
                            }}
                          >
                            保存
                          </button>
                          {cred.source === "file" && (
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              onClick={() => {
                                void saveCredential(cred.key, "", `凭证 ${cred.key} 已清除`);
                              }}
                            >
                              清除
                            </button>
                          )}
                        </div>
                      ))}

                      <div className="row" style={{ gap: 8, paddingTop: 8, borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
                        <input
                          className="input mono"
                          style={{ width: 230 }}
                          placeholder="新增凭证键名，如 LOG_API_TOKEN"
                          value={customCredKey}
                          onChange={(e) => setCustomCredKey(e.target.value)}
                        />
                        <input
                          type="password"
                          className="input mono"
                          style={{ flex: "1 1 180px" }}
                          placeholder="输入 Token 值"
                          value={customCredVal}
                          onChange={(e) => setCustomCredVal(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={!customCredKey.trim() || !customCredVal.trim()}
                          onClick={() => {
                            const k = customCredKey.trim();
                            const v = customCredVal.trim();
                            setCustomCredKey("");
                            setCustomCredVal("");
                            void saveCredential(k, v, `凭证 ${k} 已安全保存（0600）`);
                          }}
                        >
                          新增凭证
                        </button>
                      </div>
                    </div>
                  </section>
                </div>
              </details>
            </>
          )}

          {section === "appearance" && (
            <>
              <header className="settings-head">
                <h2>外观（Appearance）</h2>
                <p className="muted">选择工作台的界面主题，偏好会自动保存在当前浏览器。</p>
              </header>

              <section className="card">
                <header className="card-head">界面主题</header>
                <div className="card-body stack">
                  <div className="agent-grid-4" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
                    {(
                      [
                        ["light", "浅色", "简洁明亮的极简白底"],
                        ["dark", "深色", "低眩光深灰黑底"],
                        ["system", "跟随系统", "自动匹配 macOS 外观"],
                      ] as Array<[ThemePreference, string, string]>
                    ).map(([value, title, desc]) => (
                      <button
                        key={value}
                        type="button"
                        className={props.theme === value ? "agent-option active" : "agent-option"}
                        style={{ flexDirection: "column", alignItems: "flex-start", gap: 4, padding: "10px 12px" }}
                        onClick={() => props.onThemeChange(value)}
                      >
                        <span>{title}</span>
                        <span className="muted small" style={{ fontWeight: 400 }}>{desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            </>
          )}

          {section === "system" && (
            <>
              <header className="settings-head">
                <h2>授权策略与系统状态</h2>
                <p className="muted">原本堆在首页侧栏的策略、执行器探测与效率度量已统一收纳于此。</p>
              </header>

              <section className="card">
                <header className="card-head">
                  <span>操作权限护栏</span>
                  <span className="muted small">
                    {props.policy?.source === "file" ? "来自 ~/.timo/policy.json" : "内置安全默认规则"}
                  </span>
                </header>
                <div className="card-body stack small">
                  {props.policy?.policy ? (
                    <>
                      <div className="card-box stack" style={{ gap: 6 }}>
                        <div className="row">
                          <span className="dot dot-success" />
                          <strong>自动允许（Tier 0，{props.policy.policy.tier0.length} 项）</strong>
                          <span className="muted">本地隔离修改与测试，不打扰你</span>
                        </div>
                        <div className="muted">{formatPolicyRules(props.policy.policy.tier0)}</div>
                      </div>
                      <div className="card-box stack" style={{ gap: 6 }}>
                        <div className="row">
                          <span className="dot dot-success" />
                          <strong>主助手静默放行（Tier 1，{props.policy.policy.tier1.length} 项）</strong>
                          <span className="muted">常规开发权限由主助手自动签发并记审计</span>
                        </div>
                        <div className="muted">{formatPolicyRules(props.policy.policy.tier1)}</div>
                      </div>
                      <div className="card-box stack" style={{ gap: 6 }}>
                        <div className="row">
                          <span className="dot dot-warning" />
                          <strong>必须人工审批的红线（Tier 2，{props.policy.policy.tier2.length} 项）</strong>
                          <span className="muted">触及后立即暂停，等你点头才继续</span>
                        </div>
                        <div className="muted">{formatPolicyRules(props.policy.policy.tier2)}</div>
                      </div>
                      <div className="muted">
                        未列出的未知操作：{props.policy.policy.denyUnknownAsTier2 ? "默认按红线拦截，询问你后再执行" : "直接拒绝"} ·
                        单任务预算上限：{props.policy.policy.budget.maxRunMinutes} 分钟 / {props.policy.policy.budget.maxAttempts} 次尝试
                      </div>
                    </>
                  ) : (
                    <div className="card-box mono">{props.policy?.summary ?? "未加载（重启 timo serve 可查看完整规则明细）"}</div>
                  )}
                  {props.policy?.warning && <div style={{ color: "var(--warning)" }}>{props.policy.warning}</div>}
                </div>
              </section>

              <section className="card">
                <header className="card-head">已探测本地执行器</header>
                <div className="card-body stack small">
                  {props.executors.length === 0 ? (
                    <div className="muted">暂无执行器信息</div>
                  ) : (
                    props.executors.map((exec) => (
                      <div key={exec.id} className="row">
                        <span className={exec.available ? "dot dot-success" : "dot dot-warning"} />
                        <AgentLogo id={exec.id} size={14} />
                        <span>{agentLabel(exec.id)}</span>
                        <span className="muted small mono">{exec.id}</span>
                        <span className="muted small" style={{ marginLeft: "auto" }}>
                          {exec.available ? "就绪" : exec.reason ?? "不可用"}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </section>

              {props.metrics && (
                <section className="card">
                  <header className="card-head">效率度量（S07）</header>
                  <div className="card-body">
                    <dl className="kv">
                      <dt>总任务数</dt>
                      <dd className="mono">{props.metrics.totalTasks}</dd>
                      <dt>验收通过率</dt>
                      <dd className="mono">
                        {props.metrics.verifiedDeliveryRate === null
                          ? "—"
                          : `${Math.round(props.metrics.verifiedDeliveryRate * 100)}% (${props.metrics.verifiedCompletedTasks}/${props.metrics.terminalTasks})`}
                      </dd>
                      <dt>静默放行 / 人工打断</dt>
                      <dd className="mono">{props.metrics.totalSilentAutoGrants} / {props.metrics.totalHumanInterruptions}</dd>
                      <dt>跨执行器交接</dt>
                      <dd className="mono">{props.metrics.totalHandoffs}</dd>
                      <dt>成本计量</dt>
                      <dd className="mono">
                        {props.metrics.costStatus === "measured" && props.metrics.costUsd !== null
                          ? `$${props.metrics.costUsd.toFixed(4)}`
                          : "未知（未计量）"}
                      </dd>
                    </dl>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  read_worktree: "读取隔离工作树",
  write_worktree: "修改隔离工作树",
  run_local_tests: "运行本地单测",
  run_build: "运行本地构建",
  read_ci_status: "查看 CI 状态",
  read_logs: "查看日志",
  open_pull_request: "创建/更新 MR",
  read_repo: "读取代码仓库",
  deploy_prod: "生产发布",
  merge_main: "合并主干分支",
  write_prod: "写入生产数据",
  read_prod_sensitive_data: "读取生产敏感数据",
  read_prod_logs: "读取生产日志",
  delete_cloud_resource: "删除云资源",
  read_cross_repo: "跨仓越权读取",
  exceed_budget: "超出预算上限",
};

function formatPolicyRules(rules: PolicyRuleItem[]): string {
  if (rules.length === 0) return "无";
  return rules
    .map((rule) => {
      const label = ACTION_LABEL[rule.action] ?? rule.action;
      return rule.environment ? `${label}（${rule.environment}）` : label;
    })
    .join(" · ");
}
