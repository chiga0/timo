import { useEffect, useRef, useState } from "react";
import type { TaskSummary } from "../api.js";

/** ⌘K command palette: jump to any task. Keyboard-first, Escape closes. */
export function Palette(props: { tasks: TaskSummary[]; onSelect: (taskId: string) => void; onClose: () => void }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = props.tasks.filter((task) => {
    const text = `${task.taskId} ${task.status} ${task.waitingReason ?? ""}`.toLowerCase();
    return query.trim() === "" || text.includes(query.trim().toLowerCase());
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, matches.length - 1)));
  }, [matches.length]);

  const choose = (task: TaskSummary | undefined) => {
    if (!task) return;
    props.onSelect(task.taskId);
    props.onClose();
  };

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="palette" onClick={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="搜索任务 ID、状态或等待原因…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((current) => Math.min(current + 1, matches.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(matches[index]);
            } else if (event.key === "Escape") {
              props.onClose();
            }
          }}
        />
        <div>
          {matches.length === 0 && <div className="cmd-item muted">没有匹配的任务</div>}
          {matches.slice(0, 12).map((task, position) => (
            <div
              key={task.taskId}
              className={position === index ? "cmd-item active" : "cmd-item"}
              onMouseEnter={() => setIndex(position)}
              onClick={() => choose(task)}
            >
              <span className="mono">{task.taskId.slice(0, 8)}</span>
              <span className="muted">{task.status}</span>
              {task.waitingReason && <span className="muted">{task.waitingReason}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
