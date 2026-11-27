import { isValidElement, memo, useEffect, useId, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS: Parameters<typeof ReactMarkdown>[0]["rehypePlugins"] = [
  [rehypeHighlight, { ignoreMissing: true, plainText: ["mermaid"] }],
];

/**
 * Production Markdown renderer built on react-markdown + remark-gfm +
 * rehype-highlight + lazy-loaded Mermaid SVG rendering.
 *
 * - Safe by default (no raw HTML injection; links restricted to safe schemes).
 * - Full GFM support: scrollable tables, strikethrough, task lists, autolinks.
 * - Syntax highlighting with one-click copy and theme-adaptive styling.
 * - Lazy Mermaid diagrams that auto-adapt to light/dark theme and degrade
 *   gracefully to source code while streaming or on incomplete syntax.
 */
export const Markdown = memo(function Markdown(props: { content: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={{
          pre({ children }) {
            const codeEl = findCodeChild(children);
            const className = typeof codeEl?.props.className === "string" ? codeEl.props.className : "";
            const langMatch = className.match(/language-([A-Za-z0-9_+-]+)/);
            const lang = (langMatch?.[1] ?? "").toLowerCase();
            const rawCode = extractText(codeEl ? codeEl.props.children : children).replace(/\n$/, "");
            if (lang === "mermaid") {
              return <MermaidBlock code={rawCode} />;
            }
            return (
              <CodeBlock lang={lang} rawCode={rawCode}>
                {children}
              </CodeBlock>
            );
          },
          code({ className, children, ...rest }) {
            const isBlock = Boolean(className && /(^|\s)(language-|hljs)/.test(className));
            if (isBlock) {
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <code className="md-inline-code mono" {...rest}>
                {children}
              </code>
            );
          },
          table({ children }) {
            return (
              <div className="md-table-wrap">
                <table className="md-table">{children}</table>
              </div>
            );
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="md-link">
                {children}
              </a>
            );
          },
          input({ type, checked, ...rest }) {
            if (type === "checkbox") {
              return <input type="checkbox" className="md-checkbox" checked={Boolean(checked)} readOnly {...rest} />;
            }
            return <input type={type} {...rest} />;
          },
        }}
      >
        {props.content}
      </ReactMarkdown>
    </div>
  );
});

function CodeBlock(props: { lang: string; rawCode: string; children: ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(props.rawCode).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="md-code-wrap">
      <div className="md-code-head">
        <span className="mono">{props.lang || "code"}</span>
        <button type="button" className="md-copy-btn" onClick={copy}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="md-pre mono">{props.children}</pre>
    </div>
  );
}

let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;
let mermaidRenderCounter = 0;

function loadMermaid(): Promise<typeof import("mermaid")> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid");
  }
  return mermaidModulePromise;
}

function readIsDarkTheme(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("theme-dark");
}

function MermaidBlock(props: { code: string }): React.JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [isDark, setIsDark] = useState(readIsDarkTheme);
  const [svg, setSvg] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      setIsDark(readIsDarkTheme());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const trimmed = props.code.trim();
    if (!trimmed) {
      setSvg(null);
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        const renderId = `timo-mmd-${uid}-${++mermaidRenderCounter}`;
        try {
          const mod = await loadMermaid();
          const mermaid = mod.default;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: isDark ? "dark" : "neutral",
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
            suppressErrorRendering: true,
          });
          const valid = await mermaid.parse(trimmed, { suppressErrors: true });
          if (!valid || cancelled) {
            if (!cancelled) setSvg(null);
            return;
          }
          const rendered = await mermaid.render(renderId, trimmed);
          if (!cancelled) {
            setSvg(rendered.svg);
          }
        } catch {
          if (!cancelled) setSvg(null);
        } finally {
          document.getElementById(`d${renderId}`)?.remove();
        }
      })();
    }, 140);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [props.code, isDark, uid]);

  const copy = () => {
    void navigator.clipboard?.writeText(props.code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="md-code-wrap md-mermaid-wrap">
      <div className="md-code-head">
        <span className="mono">mermaid</span>
        <div className="row" style={{ gap: 4 }}>
          {svg && (
            <button
              type="button"
              className="md-copy-btn"
              onClick={() => setShowSource((v) => !v)}
            >
              {showSource ? "查看图表" : "源码"}
            </button>
          )}
          <button type="button" className="md-copy-btn" onClick={copy}>
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      {svg && !showSource ? (
        <div
          className="md-mermaid-canvas"
          // SVG is rendered by Mermaid with `securityLevel: "strict"`.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <pre className="md-pre mono">
          <code>{props.code}</code>
        </pre>
      )}
    </div>
  );
}

function findCodeChild(children: ReactNode): ReactElement<{ className?: string; children?: ReactNode }> | null {
  if (isValidElement(children)) {
    return children as ReactElement<{ className?: string; children?: ReactNode }>;
  }
  if (Array.isArray(children)) {
    for (const child of children) {
      if (isValidElement(child)) {
        return child as ReactElement<{ className?: string; children?: ReactNode }>;
      }
    }
  }
  return null;
}

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children);
  return "";
}
