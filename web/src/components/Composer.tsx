import { useState } from "react";

/** Fixed-to-bottom composer. Enter sends, Shift+Enter inserts a newline. */
export function Composer(props: { disabled: boolean; onSubmit: (text: string) => void }): React.JSX.Element {
  const [text, setText] = useState("");

  const submit = () => {
    const value = text.trim();
    if (value === "" || props.disabled) return;
    props.onSubmit(value);
    setText("");
  };

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        <div className="compose-box">
          <div className="compose-row">
            <textarea
              id="composer-input"
              value={text}
              placeholder="交办一件事：粘贴一段合成 SSE 日志，或描述你要核对的现象…"
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
              {props.disabled ? "服务未连接" : "输入内容会作为任务原始输入冻结归档"}
            </span>
            <button type="button" className="btn btn-primary btn-sm" disabled={props.disabled || text.trim() === ""} onClick={submit}>
              交办
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
