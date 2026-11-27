import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface NavTickItem {
  id: string;
  prompt: string;
  preview: string;
  badge?: string;
}

const BOTTOM_THRESHOLD_PX = 64;

/**
 * Smart auto-scroll hook for chat threads & task timelines:
 * - Always snaps to the bottom on initial load and whenever `resetKey` changes
 *   (page refresh, switching tasks, returning to Main Chat, switching runs/tabs).
 * - Continues following streaming updates ONLY while the user stays near the
 *   bottom; scrolling up immediately yields control and shows the scroll-to-bottom pill.
 * - Watches inner content resizing (e.g. async Markdown/Mermaid) so initial
 *   bottom-pinning stays accurate even after layout expansion.
 */
export function useAutoScroll(options: {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef?: RefObject<HTMLDivElement | null>;
  resetKey: string;
  contentVersion: string | number;
  /** Increment whenever the user explicitly submits a new message so the view snaps straight to bottom. */
  forceScrollTrigger?: number;
}): {
  showScrollButton: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  suspendFollow: () => void;
} {
  const { scrollRef, contentRef, resetKey, contentVersion, forceScrollTrigger } = options;
  const stickRef = useRef(true);
  const lastForceRef = useRef(forceScrollTrigger ?? 0);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const syncScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= BOTTOM_THRESHOLD_PX;
    stickRef.current = atBottom;
    setShowScrollButton(!atBottom && el.scrollHeight > el.clientHeight + BOTTOM_THRESHOLD_PX);
  }, [scrollRef]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const el = scrollRef.current;
      if (!el) return;
      stickRef.current = true;
      setShowScrollButton(false);
      if (behavior === "instant" || typeof el.scrollTo !== "function") {
        el.scrollTop = el.scrollHeight;
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior });
      }
    },
    [scrollRef],
  );

  const suspendFollow = useCallback(() => {
    stickRef.current = false;
  }, []);

  // Re-engage auto-bottom whenever switching view/task/run/tab.
  useLayoutEffect(() => {
    stickRef.current = true;
    setShowScrollButton(false);
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    const raf = window.requestAnimationFrame(() => {
      const cur = scrollRef.current;
      if (cur && stickRef.current) {
        cur.scrollTop = cur.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [resetKey, scrollRef]);

  // Re-engage auto-bottom immediately whenever the user actively sends a prompt.
  useLayoutEffect(() => {
    if (forceScrollTrigger === undefined || forceScrollTrigger === lastForceRef.current) return;
    lastForceRef.current = forceScrollTrigger;
    stickRef.current = true;
    setShowScrollButton(false);
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    const raf = window.requestAnimationFrame(() => {
      const cur = scrollRef.current;
      if (cur && stickRef.current) {
        cur.scrollTop = cur.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [forceScrollTrigger, scrollRef]);

  // Follow new messages / deltas / run events only while pinned to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
      const raf = window.requestAnimationFrame(() => {
        const cur = scrollRef.current;
        if (cur && stickRef.current) {
          cur.scrollTop = cur.scrollHeight;
        }
      });
      return () => window.cancelAnimationFrame(raf);
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollButton(distance > BOTTOM_THRESHOLD_PX);
  }, [contentVersion, scrollRef]);

  // Track user scroll position passively.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", syncScrollState, { passive: true });
    return () => el.removeEventListener("scroll", syncScrollState);
  }, [scrollRef, syncScrollState, resetKey]);

  // Keep pinned to bottom if async content (Mermaid, code highlight, images) expands height.
  useEffect(() => {
    const content = contentRef?.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (!el) return;
      if (stickRef.current) {
        el.scrollTop = el.scrollHeight;
      } else {
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        setShowScrollButton(distance > BOTTOM_THRESHOLD_PX);
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [contentRef, scrollRef, resetKey]);

  return { showScrollButton, scrollToBottom, suspendFollow };
}

/**
 * Codex-inspired floating "scroll to bottom" button:
 * - While replying / running (`active === true`): pill with animated three dots (`• • •`)
 * - When idle / finished (`active === false`): compact circular down-arrow (`↓`)
 */
export function ScrollToBottomButton(props: {
  visible: boolean;
  active: boolean;
  onClick: () => void;
  className?: string;
}): React.JSX.Element | null {
  if (!props.visible) return null;
  const label = props.active ? "正在生成，点击回到底部跟随" : "回到底部";
  return (
    <button
      type="button"
      className={[
        "stb-btn",
        props.active ? "is-active" : "is-idle",
        props.className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
      title={label}
      onClick={props.onClick}
    >
      {props.active ? (
        <span className="stb-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="m19 12-7 7-7-7" />
        </svg>
      )}
    </button>
  );
}

/**
 * Codex-inspired left-edge prompt timeline minimap:
 * - Renders a sleek vertical tick rail on the left margin (one horizontal tick per prompt turn).
 * - Highlights the turn currently visible in the viewport.
 * - Hovering any tick opens a floating preview card showing the user prompt + assistant summary.
 * - Clicking any tick smoothly jumps to that prompt turn and briefly highlights it.
 */
export function ConversationMinimap(props: {
  items: NavTickItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
  onJump?: (id: string) => void;
}): React.JSX.Element | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [popoverTop, setPopoverTop] = useState<number>(24);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Sync highlighted tick with the current scroll position.
  useEffect(() => {
    const container = props.scrollRef.current;
    if (!container || props.items.length < 2) return;

    const updateActive = () => {
      const containerRect = container.getBoundingClientRect();
      const anchorY = containerRect.top + containerRect.height * 0.28;
      let bestId: string | null = props.items[0]?.id ?? null;
      let bestDist = Infinity;

      for (const item of props.items) {
        const node = container.querySelector<HTMLElement>(`[data-nav-id="${CSS.escape(item.id)}"]`);
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        // Prefer the latest turn whose top is above or near the anchor line.
        const dist = Math.abs(rect.top - anchorY);
        if (rect.top <= anchorY + 40) {
          bestId = item.id;
          bestDist = dist;
        } else if (bestDist === Infinity && dist < bestDist) {
          bestId = item.id;
          bestDist = dist;
        }
      }
      setActiveId(bestId);
    };

    updateActive();
    container.addEventListener("scroll", updateActive, { passive: true });
    return () => container.removeEventListener("scroll", updateActive);
  }, [props.items, props.scrollRef]);

  if (props.items.length < 2) return null;

  const hoveredItem = hoveredId ? props.items.find((i) => i.id === hoveredId) ?? null : null;
  const hoveredIndex = hoveredItem ? props.items.findIndex((i) => i.id === hoveredItem.id) : -1;

  const handleHover = (itemId: string, buttonEl: HTMLButtonElement) => {
    setHoveredId(itemId);
    const wrap = wrapRef.current;
    if (!wrap) return;
    const wrapRect = wrap.getBoundingClientRect();
    const btnRect = buttonEl.getBoundingClientRect();
    const rawTop = btnRect.top - wrapRect.top + btnRect.height / 2;
    const clamped = Math.max(54, Math.min(wrapRect.height - 72, rawTop));
    setPopoverTop(clamped);
  };

  const handleJump = (itemId: string) => {
    const container = props.scrollRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-nav-id="${CSS.escape(itemId)}"]`);
    if (!target) return;
    props.onJump?.(itemId);
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const nextTop = container.scrollTop + (targetRect.top - containerRect.top) - 20;
    container.scrollTo({ top: Math.max(0, nextTop), behavior: "smooth" });
    setActiveId(itemId);
    // Brief visual pulse so the eye locks onto the jumped prompt immediately.
    target.classList.remove("nav-jump-flash");
    void target.offsetWidth;
    target.classList.add("nav-jump-flash");
    window.setTimeout(() => target.classList.remove("nav-jump-flash"), 1200);
  };

  return (
    <nav
      ref={wrapRef}
      className="minimap-wrap"
      aria-label="会话记录快速导航"
      onMouseLeave={() => setHoveredId(null)}
    >
      <div className="minimap-rail">
        {props.items.map((item, idx) => {
          const isActive = item.id === activeId;
          const isHovered = item.id === hoveredId;
          return (
            <button
              key={item.id}
              type="button"
              className={[
                "minimap-tick",
                isActive ? "is-active" : "",
                isHovered ? "is-hovered" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-label={`跳转到第 ${idx + 1} 条提问：${item.prompt.slice(0, 40)}`}
              onMouseEnter={(e) => handleHover(item.id, e.currentTarget)}
              onFocus={(e) => handleHover(item.id, e.currentTarget)}
              onClick={() => handleJump(item.id)}
            >
              <span className="minimap-bar" aria-hidden="true" />
            </button>
          );
        })}
      </div>

      {hoveredItem && (
        <div
          className="minimap-popover"
          style={{ top: popoverTop }}
          role="tooltip"
        >
          <div className="minimap-pop-head">
            <span className="minimap-pop-prompt">{hoveredItem.prompt}</span>
            <span className="minimap-pop-idx mono">
              {hoveredItem.badge ? `${hoveredItem.badge} · ` : ""}#{hoveredIndex + 1}
            </span>
          </div>
          {hoveredItem.preview && (
            <div className="minimap-pop-preview">{hoveredItem.preview}</div>
          )}
        </div>
      )}
    </nav>
  );
}

/** Strips lightweight Markdown tokens into crisp plain text for hover preview cards. */
export function stripMarkdownPreview(raw: string, maxLen = 180): string {
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, " [代码片段] ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}
