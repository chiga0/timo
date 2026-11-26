export function Topbar(props: {
  leftOpen: boolean;
  rightOpen: boolean;
  theme: "light" | "dark";
  tab: "thread" | "live";
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onTheme: (theme: "light" | "dark") => void;
  onTab: (tab: "thread" | "live") => void;
  onPalette: () => void;
}): React.JSX.Element {
  return (
    <>
      <div className="top-left">
        <button
          type="button"
          className={props.leftOpen ? "icon-btn active" : "icon-btn"}
          title="展开/收起左侧栏 ([)"
          onClick={props.onToggleLeft}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M9 3v18" />
          </svg>
        </button>
        <div className="brand">
          <span className="brand-mark">T</span>
          <span>Timo</span>
          <span className="brand-ver mono">v0.2</span>
        </div>
        <span className="vsep" />
        <div className="seg" role="tablist">
          <button type="button" className={props.tab === "thread" ? "active" : ""} onClick={() => props.onTab("thread")}>
            主对话
          </button>
          <button type="button" className={props.tab === "live" ? "active" : ""} onClick={() => props.onTab("live")}>
            实时运行流
          </button>
        </div>
      </div>

      <div className="top-right">
        <button type="button" className="cmd-trigger" onClick={props.onPalette}>
          <span>搜索或切换任务...</span>
          <span className="kbd mono">⌘K</span>
        </button>
        <div className="seg" aria-label="黑白主题切换">
          <button type="button" className={props.theme === "light" ? "active" : ""} onClick={() => props.onTheme("light")}>
            浅色
          </button>
          <button type="button" className={props.theme === "dark" ? "active" : ""} onClick={() => props.onTheme("dark")}>
            深色
          </button>
        </div>
        <button
          type="button"
          className={props.rightOpen ? "icon-btn active" : "icon-btn"}
          title="展开/收起右侧检查器 (])"
          onClick={props.onToggleRight}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M15 3v18" />
          </svg>
        </button>
      </div>
    </>
  );
}
