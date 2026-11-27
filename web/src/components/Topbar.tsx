export function Topbar(props: {
  leftOpen: boolean;
  rightOpen: boolean;
  hasSelection: boolean;
  view: "workbench" | "settings";
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onView: (view: "workbench" | "settings") => void;
  onPalette: () => void;
}): React.JSX.Element {
  return (
    <>
      <div className="top-left">
        <button
          type="button"
          className="brand brand-btn"
          onClick={() => props.onView("workbench")}
          title="返回工作台"
        >
          <span className="brand-mark">T</span>
          <span>Timo</span>
        </button>
        {props.view === "workbench" && (
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
        )}
        {props.view === "settings" && (
          <>
            <span className="vsep" />
            <button type="button" className="btn btn-sm" onClick={() => props.onView("workbench")}>
              ← 返回工作台
            </button>
          </>
        )}
      </div>

      <div className="top-center">
        {props.view === "workbench" && (
          <button type="button" className="cmd-trigger" onClick={props.onPalette}>
            <span>搜索任务…</span>
            <span className="kbd mono">⌘K</span>
          </button>
        )}
      </div>

      <div className="top-right">
        {props.view === "workbench" && props.hasSelection && (
          <button
            type="button"
            className={props.rightOpen ? "icon-btn active" : "icon-btn"}
            title="展开/收起任务详情 (])"
            onClick={props.onToggleRight}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M15 3v18" />
            </svg>
          </button>
        )}
      </div>
    </>
  );
}
