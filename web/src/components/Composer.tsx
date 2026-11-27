import { useEffect, useState } from "react";
import type { ExecutorDescriptor } from "../api.js";

export type ComposerSubmission =
  | { kind: "sse_log"; text: string }
  | { kind: "repo_delivery"; text: string; executorId: string; sourcePath: string; baseRef: string; checkCommand: string };

/**
 * Fixed-to-bottom composer supporting both repo code delivery (worktree +
 * independent verification) and zero-repo SSE log diagnosis.
 */
export function Composer(props: {
  disabled: boolean;
  defaultRepoPath: string;
  executors: ExecutorDescriptor[];
  onSubmit: (submission: ComposerSubmission) => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<"repo_delivery" | "sse_log">("repo_delivery");
  const [text, setText] = useState("");
  const [repoPath, setRepoPath] = useState(props.defaultRepoPath);
  const [baseRef, setBaseRef] = useState("main");
  const [checkCommand, setCheckCommand] = useState("npm run typecheck && npm test");
  const [executorId, setExecutorId] = useState("qwen-code");

  useEffect(() => {
    if (props.defaultRepoPath && repoPath === "") {
      setRepoPath(props.defaultRepoPath);
    }
  }, [props.defaultRepoPath]);

  useEffect(() => {
    const ready = props.executors.filter((e) => e.available);
    if (ready.length > 0 && !ready.some((e) => e.id === executorId)) {
      const preferred = ready.find((e) => e.id === "qwen-code") ?? ready[0]!;
      setExecutorId(preferred.id);
    }
  }, [props.executors]);

  const canSubmit =
    !props.disabled &&
    text.trim() !== "" &&
    (mode === "sse_log" || (repoPath.trim() !== "" && baseRef.trim() !== "" && checkCommand.trim() !== ""));

  const submit = () => {
    if (!canSubmit) return;
    const value = text.trim();
    if (mode === "repo_delivery") {
      props.onSubmit({
        kind: "repo_delivery",
        text: value,
        executorId,
        sourcePath: repoPath.trim(),
        baseRef: baseRef.trim(),
        checkCommand: checkCommand.trim(),
      });
    } else {
      props.onSubmit({ kind: "sse_log", text: value });
    }
    setText("");
  };

  const executorOptions =
    props.executors.length > 0
      ? props.executors
      : [
          { id: "pi", kind: "cli" as const, available: true, capabilities: {} },
          { id: "qwen-code", kind: "cli" as const, available: true, capabilities: {} },
          { id: "codex", kind: "cli" as const, available: true, capabilities: {} },
          { id: "opencode", kind: "cli" as const, available: true, capabilities: {} },
        ];

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        <div className="compose-box">
          <div className="compose-foot" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 8, marginBottom: 6, flexWrap: "wrap", gap: 6 }}>
            <div className="seg">
              <button type="button" className={mode === "repo_delivery" ? "active" : ""} onClick={() => setMode("repo_delivery")}>
                代码交付
              </button>
              <button type="button" className={mode === "sse_log" ? "active" : ""} onClick={() => setMode("sse_log")}>
                日志诊断
              </button>
            </div>
            {mode === "repo_delivery" && (
              <>
                <select
                  aria-label="执行器"
                  className="card-box mono small"
                  style={{ border: "1px solid var(--border)", padding: "2px 6px", width: "auto" }}
                  value={executorId}
                  onChange={(event) => setExecutorId(event.target.value)}
                >
                  {executorOptions.map((exec) => (
                    <option key={exec.id} value={exec.id} disabled={!exec.available}>
                      {exec.id}
                      {exec.available ? "" : " (不可用)"}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="仓库路径"
                  className="card-box mono small"
                  style={{ border: "1px solid var(--border)", padding: "2px 6px", flex: "1 1 180px", minWidth: 140 }}
                  placeholder="仓库绝对路径"
                  value={repoPath}
                  onChange={(event) => setRepoPath(event.target.value)}
                />
                <input
                  aria-label="基线分支"
                  className="card-box mono small"
                  style={{ border: "1px solid var(--border)", padding: "2px 6px", width: 84 }}
                  placeholder="main"
                  value={baseRef}
                  onChange={(event) => setBaseRef(event.target.value)}
                />
                <input
                  aria-label="验收命令"
                  className="card-box mono small"
                  style={{ border: "1px solid var(--border)", padding: "2px 6px", flex: "1 1 180px", minWidth: 140 }}
                  placeholder="npm run typecheck && npm test"
                  value={checkCommand}
                  onChange={(event) => setCheckCommand(event.target.value)}
                />
              </>
            )}
          </div>
          <div className="compose-row">
            <textarea
              id="composer-input"
              value={text}
              placeholder={
                mode === "repo_delivery"
                  ? "交办一项开发任务（将在独立 worktree 修改并自动跑干净环境单测验收）…"
                  : "交办一件事：粘贴一段合成 SSE 日志，或描述你要核对的现象…"
              }
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          <div className="compose-foot">
            <span className="hint">Enter 发送 · Shift+Enter 换行</span>
            <span className="hint" style={{ marginLeft: "auto" }}>
              {props.disabled
                ? "服务未连接"
                : mode === "repo_delivery"
                  ? `独立 worktree · ${executorId} · 禁止生产发布`
                  : "输入内容会作为任务原始输入冻结归档"}
            </span>
            <button type="button" className="btn btn-primary btn-sm" disabled={!canSubmit} onClick={submit}>
              交办
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
