import { useEffect, useRef, useState } from "react";
import {
  readSessionToken,
  type ChatAttachment,
  type ChatContextSummary,
  type ExecutorDescriptor,
  type ExecutorProviderCatalog,
  type SkillRecord,
  type TimoUserSettings,
  type WorkspaceFolderConfig,
} from "../api.js";
import { AgentLogo, agentLabel } from "./AgentIcons.js";
import { useImeGuard } from "./ime.js";

const MAX_ATTACHMENTS = 8;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

export type ComposerSubmission =
  | { kind: "sse_log"; text: string }
  | {
      kind: "repo_delivery";
      text: string;
      executorId: string;
      model?: string;
      sourcePath?: string;
      baseRef?: string;
      checkCommand?: string;
      attachments?: ChatAttachment[];
    };

/**
 * Minimal bottom composer: clean textarea + ultra-quiet icon-first footer.
 * Supports pasting screenshots/files (`Cmd+V`), drag-and-drop, and click `+` upload.
 * Agent brand logo opens a compact popover to switch agent & model; advanced
 * overrides (branch / check command / log mode) stay tucked behind a subtle icon.
 */
export function Composer(props: {
  disabled: boolean;
  isStreaming?: boolean;
  onStopStreaming?: () => void;
  defaultRepoPath: string;
  executors: ExecutorDescriptor[];
  executorProviders?: Record<string, ExecutorProviderCatalog>;
  settings: TimoUserSettings | null;
  selectedExecutorId: string;
  selectedModel: string;
  onSelectExecutor: (executorId: string) => void;
  onSelectModel: (model: string) => void;
  contextSummary?: ChatContextSummary | null;
  skills?: SkillRecord[];
  onUploadAttachment?: (input: { name: string; mimeType: string; dataBase64: string }) => Promise<ChatAttachment>;
  onDeleteAttachment?: (id: string) => Promise<void>;
  onOpenSettings: (section?: "assistant" | "folders" | "skills" | "connections" | "appearance" | "system") => void;
  onSubmit: (submission: ComposerSubmission) => void;
}): React.JSX.Element {
  const folders: WorkspaceFolderConfig[] =
    props.settings?.folders && props.settings.folders.length > 0
      ? props.settings.folders
      : (props.settings?.projects ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          path: p.localPath,
          kind: "git" as const,
          baseRef: p.baseRef,
          checkCommand: p.checkCommand,
        }));
  const gitFolders = folders.filter((f) => f.kind !== "docs");
  const selectableFolders = gitFolders.length > 0 ? gitFolders : folders;

  const [selectedFolderId, setSelectedFolderId] = useState<string>("__auto__");
  const [mode, setMode] = useState<"repo_delivery" | "sse_log">("repo_delivery");
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [text, setText] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [baseRef, setBaseRef] = useState("main");
  const [checkCommand, setCheckCommand] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const ime = useImeGuard();

  const executorId = props.selectedExecutorId;
  const modelOverride = props.selectedModel;

  useEffect(() => {
    if (!agentMenuOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setAgentMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [agentMenuOpen]);

  useEffect(() => {
    if (!props.settings) return;
    if (selectedFolderId !== "__auto__" && selectedFolderId !== "__custom__") {
      const match = selectableFolders.find((f) => f.id === selectedFolderId);
      if (match) {
        setRepoPath(match.path);
        setBaseRef(match.baseRef || "main");
        setCheckCommand(match.checkCommand || "");
      } else {
        setSelectedFolderId("__auto__");
        setRepoPath("");
      }
    }
  }, [props.settings]);

  const savedModelForExecutor = props.settings?.assistant.executorModels[executorId] ?? "";
  const effectiveModel = modelOverride.trim() || savedModelForExecutor;

  const selectFolder = (id: string) => {
    setSelectedFolderId(id);
    if (id === "__auto__") {
      setRepoPath("");
      setCheckCommand("");
      return;
    }
    if (id === "__custom__") {
      setRepoPath(props.defaultRepoPath);
      setShowAdvanced(true);
      return;
    }
    const found = selectableFolders.find((f) => f.id === id);
    if (found) {
      setRepoPath(found.path);
      setBaseRef(found.baseRef || "main");
      setCheckCommand(found.checkCommand || "");
    }
  };

  const uploadFiles = async (incoming: FileList | File[]) => {
    if (!props.onUploadAttachment) return;
    const files = Array.from(incoming);
    if (files.length === 0) return;
    setAttachError(null);
    const remainingSlots = MAX_ATTACHMENTS - attachments.length;
    if (remainingSlots <= 0) {
      setAttachError(`单条消息最多附加 ${MAX_ATTACHMENTS} 个文件`);
      return;
    }
    const batch = files.slice(0, remainingSlots);
    if (files.length > remainingSlots) {
      setAttachError(`已截取前 ${remainingSlots} 个文件（单条消息上限 ${MAX_ATTACHMENTS} 个）`);
    }
    for (const file of batch) {
      if (file.size === 0) {
        setAttachError(`文件「${file.name || "未命名"}」为空，已跳过`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setAttachError(`文件「${file.name || "未命名"}」超过 15 MB 上限`);
        continue;
      }
      setUploadingCount((n) => n + 1);
      try {
        const dataBase64 = await readFileAsBase64(file);
        const fallbackName = file.name?.trim() || guessClipboardFileName(file.type);
        const saved = await props.onUploadAttachment({
          name: fallbackName,
          mimeType: file.type || "application/octet-stream",
          dataBase64,
        });
        setAttachments((prev) => [...prev, saved]);
      } catch (err) {
        setAttachError(`上传失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setUploadingCount((n) => Math.max(0, n - 1));
      }
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    void props.onDeleteAttachment?.(id);
  };

  const canSubmit =
    !props.disabled &&
    uploadingCount === 0 &&
    (text.trim() !== "" || (mode === "repo_delivery" && attachments.length > 0)) &&
    (mode === "sse_log" || selectedFolderId === "__auto__" || (repoPath.trim() !== "" && baseRef.trim() !== ""));

  const submit = () => {
    if (!canSubmit) return;
    const value = text.trim();
    const sentAttachments = attachments;
    if (mode === "repo_delivery") {
      props.onSubmit({
        kind: "repo_delivery",
        text: value,
        executorId,
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(sentAttachments.length > 0 ? { attachments: sentAttachments } : {}),
        ...(selectedFolderId === "__auto__"
          ? { ...(checkCommand.trim() ? { checkCommand: checkCommand.trim() } : {}) }
          : {
              sourcePath: repoPath.trim(),
              baseRef: baseRef.trim(),
              checkCommand: checkCommand.trim(),
            }),
      });
    } else {
      props.onSubmit({ kind: "sse_log", text: value });
    }
    setText("");
    setAttachments([]);
    setAttachError(null);
  };

  const executorOptions =
    props.executors.length > 0
      ? props.executors
      : [
          { id: "qwen-code", kind: "cli" as const, available: true, capabilities: {} },
          { id: "pi", kind: "cli" as const, available: true, capabilities: {} },
          { id: "codex", kind: "cli" as const, available: true, capabilities: {} },
          { id: "opencode", kind: "cli" as const, available: true, capabilities: {} },
        ];

  const enabledSkills = (props.skills ?? []).filter((s) => s.enabled);
  const slashQuery = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const slashSuggestions =
    slashQuery !== null
      ? enabledSkills
          .filter((s) => s.id.toLowerCase().includes(slashQuery) || s.name.toLowerCase().includes(slashQuery))
          .slice(0, 5)
      : [];

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {slashSuggestions.length > 0 && (
          <div className="slash-bar" role="listbox" aria-label="Timo 统一 Skills 快捷调用">
            {slashSuggestions.map((skill) => (
              <button
                key={skill.id}
                type="button"
                className="slash-chip"
                onClick={() => {
                  setText(`/${skill.id} `);
                  document.getElementById("composer-input")?.focus();
                }}
              >
                <span className="mono" style={{ fontWeight: 600 }}>/{skill.id}</span>
                <span className="muted">{skill.description.slice(0, 42)}</span>
              </button>
            ))}
          </div>
        )}
        <div
          className={dragging ? "compose-box is-dragging" : "compose-box"}
          onDragOver={(event) => {
            if (!props.onUploadAttachment || mode !== "repo_delivery") return;
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              if (!dragging) setDragging(true);
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            setDragging(false);
            if (!props.onUploadAttachment || mode !== "repo_delivery") return;
            if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
              event.preventDefault();
              void uploadFiles(event.dataTransfer.files);
            }
          }}
        >
          {dragging && (
            <div className="compose-drop-hint">松开鼠标添加图片或文件</div>
          )}
          {(attachments.length > 0 || uploadingCount > 0 || attachError) && (
            <div className="compose-attach-strip">
              {attachments.map((att) =>
                att.isImage ? (
                  <div key={att.id} className="compose-attach-thumb" title={`${att.name} (${formatFileSize(att.sizeBytes)})`}>
                    <img src={withAuthToken(att.url)} alt={att.name} />
                    <button
                      type="button"
                      className="compose-attach-rm"
                      aria-label={`移除 ${att.name}`}
                      onClick={() => removeAttachment(att.id)}
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <div key={att.id} className="compose-attach-chip" title={`${att.name} (${formatFileSize(att.sizeBytes)})`}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span className="compose-attach-name">{att.name}</span>
                    <span className="muted mono" style={{ fontSize: 10 }}>{formatFileSize(att.sizeBytes)}</span>
                    <button
                      type="button"
                      className="compose-attach-chip-rm"
                      aria-label={`移除 ${att.name}`}
                      onClick={() => removeAttachment(att.id)}
                    >
                      ×
                    </button>
                  </div>
                ),
              )}
              {uploadingCount > 0 && (
                <div className="compose-attach-chip muted">
                  <span className="dot dot-warning dot-pulse" />
                  <span>正在上传 {uploadingCount} 个附件…</span>
                </div>
              )}
              {attachError && (
                <div className="compose-attach-err">{attachError}</div>
              )}
            </div>
          )}
          <div className="compose-row">
            <textarea
              id="composer-input"
              name="timo_chat_prompt"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              value={text}
              placeholder={
                mode === "repo_delivery"
                  ? "向 Timo 提问、查进度，或直接粘贴/拖入图片与文件…"
                  : "粘贴 SSE 日志或描述需要诊断的问题…"
              }
              onChange={(event) => setText(event.target.value)}
              onPaste={(event) => {
                if (!props.onUploadAttachment || mode !== "repo_delivery") return;
                const pasted: File[] = [];
                const seen = new Set<string>();
                for (const item of Array.from(event.clipboardData?.items ?? [])) {
                  if (item.kind === "file") {
                    const f = item.getAsFile();
                    if (f) {
                      const key = `${f.name}:${f.size}:${f.type}`;
                      if (!seen.has(key)) {
                        seen.add(key);
                        pasted.push(f);
                      }
                    }
                  }
                }
                for (const f of Array.from(event.clipboardData?.files ?? [])) {
                  const key = `${f.name}:${f.size}:${f.type}`;
                  if (!seen.has(key)) {
                    seen.add(key);
                    pasted.push(f);
                  }
                }
                if (pasted.length > 0) {
                  const hasPlainText = Boolean(event.clipboardData?.getData("text/plain")?.trim());
                  if (!hasPlainText) event.preventDefault();
                  void uploadFiles(pasted);
                }
              }}
              {...ime.compositionProps}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !ime.isImeEvent(event)) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>

          {showAdvanced && (
            <div className="compose-adv">
              <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                <div className="seg">
                  <button type="button" className={mode === "repo_delivery" ? "active" : ""} onClick={() => setMode("repo_delivery")}>
                    代码交付
                  </button>
                  <button type="button" className={mode === "sse_log" ? "active" : ""} onClick={() => setMode("sse_log")}>
                    日志诊断
                  </button>
                </div>
                {mode === "repo_delivery" && (
                  <button type="button" className="btn-link" style={{ marginLeft: "auto" }} onClick={() => props.onOpenSettings("folders")}>
                    管理仓库与默认模型 →
                  </button>
                )}
              </div>
              {mode === "repo_delivery" && (
                <div className="compose-adv-grid">
                  <label className="field">
                    <span className="field-label">仓库路径</span>
                    <input
                      aria-label="仓库路径"
                      className="input mono"
                      placeholder="/path/to/folder"
                      value={repoPath}
                      onChange={(event) => {
                        setSelectedFolderId("__custom__");
                        setRepoPath(event.target.value);
                      }}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">基线分支</span>
                    <input
                      aria-label="基线分支"
                      className="input mono"
                      placeholder="main"
                      value={baseRef}
                      onChange={(event) => setBaseRef(event.target.value)}
                    />
                  </label>
                  <label className="field" style={{ gridColumn: "1 / -1" }}>
                    <span className="field-label">验收命令（可选，留空自动跳过或仅验证代码提交）</span>
                    <input
                      aria-label="验收命令"
                      className="input mono"
                      placeholder="留空或填写如 npm run typecheck && npm test"
                      value={checkCommand}
                      onChange={(event) => setCheckCommand(event.target.value)}
                    />
                  </label>
                </div>
              )}
            </div>
          )}

          <div className="compose-foot compose-foot-minimal">
            {mode === "repo_delivery" ? (
              <>
                {props.onUploadAttachment && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      style={{ display: "none" }}
                      onChange={(event) => {
                        if (event.target.files && event.target.files.length > 0) {
                          void uploadFiles(event.target.files);
                        }
                        event.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={props.disabled || uploadingCount > 0}
                      title="上传图片或文件（也支持直接粘贴截图或拖拽放入）"
                      aria-label="上传图片或文件"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </button>
                  </>
                )}
                <div className="agent-picker" ref={menuRef}>
                  <button
                    type="button"
                    className={agentMenuOpen ? "ghost-pill active" : "ghost-pill"}
                    title={`执行器：${agentLabel(executorId)}${effectiveModel ? ` · ${effectiveModel}` : ""}`}
                    onClick={() => setAgentMenuOpen((open) => !open)}
                  >
                    <AgentLogo id={executorId} size={15} />
                    <span className="pill-agent-name">{agentLabel(executorId)}</span>
                    {effectiveModel && <span className="mono pill-model">· {effectiveModel}</span>}
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.6">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>

                  {agentMenuOpen && (
                    <div className="agent-popover" role="dialog" aria-label="选择执行器与模型">
                      <div className="popover-label">选择代理</div>
                      <div className="agent-grid">
                        {executorOptions.map((exec) => {
                          const selected = exec.id === executorId;
                          const isDefault = exec.id === props.settings?.assistant.defaultExecutor;
                          return (
                            <button
                              key={exec.id}
                              type="button"
                              disabled={!exec.available}
                              className={selected ? "agent-option active" : "agent-option"}
                              onClick={() => {
                                props.onSelectExecutor(exec.id);
                                props.onSelectModel("");
                              }}
                            >
                              <AgentLogo id={exec.id} size={16} />
                              <span>{agentLabel(exec.id)}</span>
                              {!exec.available ? (
                                <span className="muted small" style={{ marginLeft: "auto" }}>未就绪</span>
                              ) : isDefault ? (
                                <span className="muted small" style={{ marginLeft: "auto" }}>默认</span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                      <div className="popover-divider" />
                      {(() => {
                        const catalog = props.executorProviders?.[executorId];
                        const providers = catalog?.providers ?? [];
                        const hasDiscovered = providers.some((p) => p.models.length > 0);
                        return (
                          <div className="stack" style={{ gap: 6 }}>
                            <span className="field-label">
                              模型{catalog?.defaultModel ? `（CLI 默认：${catalog.defaultModel}）` : "（留空用 CLI 默认）"}
                            </span>
                            {hasDiscovered && (
                              <select
                                aria-label="选择已探测模型"
                                className="input mono"
                                value={effectiveModel}
                                onChange={(event) => props.onSelectModel(event.target.value)}
                              >
                                <option value="">使用默认模型{catalog?.defaultModel ? ` (${catalog.defaultModel})` : ""}</option>
                                {providers.map((prov) =>
                                  prov.models.length > 0 ? (
                                    <optgroup key={prov.id} label={prov.name}>
                                      {prov.models.map((m) => (
                                        <option key={m.id} value={m.id}>
                                          {m.label}
                                        </option>
                                      ))}
                                    </optgroup>
                                  ) : null,
                                )}
                              </select>
                            )}
                            <input
                              className="input mono"
                              placeholder={savedModelForExecutor || catalog?.defaultModel || "或手动输入模型 ID"}
                              value={modelOverride}
                              onChange={(event) => props.onSelectModel(event.target.value)}
                            />
                          </div>
                        );
                      })()}
                      <div className="row" style={{ marginTop: 6, justifyContent: "space-between" }}>
                        <span className="muted small">
                          {effectiveModel ? `当前：${effectiveModel}` : "当前：默认模型"}
                        </span>
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => {
                            setAgentMenuOpen(false);
                            props.onOpenSettings();
                          }}
                        >
                          模型设置 →
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <label className="repo-pill" title={selectedFolderId === "__auto__" ? "Timo 会根据需求自动匹配工作区目录并管理 Worktree" : `限定目录：${repoPath}`}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                  </svg>
                  <select
                    aria-label="工作区范围"
                    className="repo-select"
                    autoComplete="off"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    value={selectedFolderId}
                    onChange={(event) => {
                      if (event.target.value === "__add__") {
                        props.onOpenSettings();
                        return;
                      }
                      selectFolder(event.target.value);
                    }}
                  >
                    <option value="__auto__">自动匹配工作区</option>
                    {selectableFolders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                    <option value="__custom__">指定路径…</option>
                    <option value="__add__">+ 管理工作区</option>
                  </select>
                </label>

                {props.contextSummary && (
                  <button
                    type="button"
                    className="ctx-status-pill"
                    onClick={() => props.onOpenSettings("skills")}
                    title={`Timo 主助手已装配上下文：${props.contextSummary.folderCount} 个工作区、${props.contextSummary.knowledgeCount} 个知识源、${props.contextSummary.enabledSkillCount} 个统一 Skill${props.contextSummary.chiefMcpTools.length > 0 ? `、${props.contextSummary.chiefMcpTools.length} 个控制面 MCP 工具` : ""}（点击管理）`}
                  >
                    <span className="dot dot-success" />
                    <span>
                      {props.contextSummary.enabledSkillCount} Skills
                      {props.contextSummary.knowledgeCount > 0 ? ` · ${props.contextSummary.knowledgeCount} 知识源` : ""}
                      {props.contextSummary.chiefMcpTools.length > 0 ? " · MCP" : ""}
                    </span>
                  </button>
                )}
              </>
            ) : (
              <span className="ctx-chip">日志诊断</span>
            )}

            <div className="row" style={{ marginLeft: "auto", gap: 6 }}>
              <button
                type="button"
                className={showAdvanced ? "icon-btn active" : "icon-btn"}
                onClick={() => setShowAdvanced((open) => !open)}
                title="高级选项（分支、验收命令、日志诊断模式）"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <line x1="4" x2="20" y1="6" y2="6" />
                  <circle cx="9" cy="6" r="2" fill="var(--bg)" />
                  <line x1="4" x2="20" y1="12" y2="12" />
                  <circle cx="15" cy="12" r="2" fill="var(--bg)" />
                  <line x1="4" x2="20" y1="18" y2="18" />
                  <circle cx="10" cy="18" r="2" fill="var(--bg)" />
                </svg>
              </button>
              {props.isStreaming && props.onStopStreaming && text.trim() === "" && attachments.length === 0 ? (
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={props.onStopStreaming}
                >
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!canSubmit}
                  onClick={submit}
                >
                  发送
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取文件内容"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function guessClipboardFileName(mimeType: string): string {
  const ext =
    mimeType === "image/png"
      ? ".png"
      : mimeType === "image/jpeg"
        ? ".jpg"
        : mimeType === "image/webp"
          ? ".webp"
          : mimeType === "image/gif"
            ? ".gif"
            : mimeType === "application/pdf"
              ? ".pdf"
              : ".bin";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `pasted-${stamp}${ext}`;
}

function withAuthToken(url: string): string {
  const token = readSessionToken();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
