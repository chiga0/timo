import { useState, type ReactNode } from "react";

/**
 * Lightweight, zero-dependency, XSS-safe Markdown renderer for Timo replies.
 * Supports fenced code blocks (with copy button), headings, lists, blockquotes,
 * horizontal rules, inline code, bold, italic, and safe http(s) links.
 */
export function Markdown(props: { content: string }): React.JSX.Element {
  const blocks = parseBlocks(props.content);
  return (
    <div className="md">
      {blocks.map((block, idx) => {
        if (block.type === "code") {
          return <CodeBlock key={idx} lang={block.lang} code={block.code} />;
        }
        if (block.type === "heading") {
          const Tag = block.level <= 2 ? "h3" : "h4";
          return <Tag key={idx} className={`md-h${block.level}`}>{renderInline(block.text)}</Tag>;
        }
        if (block.type === "ul") {
          return (
            <ul key={idx} className="md-list">
              {block.items.map((item, i) => (
                <li key={i}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "ol") {
          return (
            <ol key={idx} className="md-list">
              {block.items.map((item, i) => (
                <li key={i}>{renderInline(item)}</li>
              ))}
            </ol>
          );
        }
        if (block.type === "quote") {
          return <blockquote key={idx} className="md-quote">{renderInline(block.text)}</blockquote>;
        }
        if (block.type === "hr") {
          return <hr key={idx} className="md-hr" />;
        }
        return <p key={idx} className="md-p">{renderInline(block.text)}</p>;
      })}
    </div>
  );
}

function CodeBlock(props: { lang: string; code: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(props.code).then(() => {
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
      <pre className="md-pre mono"><code>{props.code}</code></pre>
    </div>
  );
}

type Block =
  | { type: "code"; lang: string; code: string }
  | { type: "heading"; level: number; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "p"; text: string };

function parseBlocks(raw: string): Block[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "") {
      i += 1;
      continue;
    }

    // Fenced code block
    const fence = trimmed.match(/^```([A-Za-z0-9_+-]*)/);
    if (fence) {
      const lang = fence[1] ?? "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1; // closing fence
      blocks.push({ type: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    // Horizontal rule
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    // Heading
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]! });
      i += 1;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", text: quoteLines.join("\n") });
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.trim().replace(/^[-*+]\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.trim().replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // Paragraph (absorb consecutive plain lines)
    const para: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i]!;
      const nt = next.trim();
      if (
        nt === "" ||
        nt.startsWith("```") ||
        /^#{1,4}\s+/.test(nt) ||
        nt.startsWith(">") ||
        /^[-*+]\s+/.test(nt) ||
        /^\d+\.\s+/.test(nt) ||
        /^([-*_])\1{2,}$/.test(nt)
      ) {
        break;
      }
      para.push(next);
      i += 1;
    }
    blocks.push({ type: "p", text: para.join("\n") });
  }

  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Tokenize inline code, bold, italic, and safe http(s) markdown links.
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) {
      out.push(text.slice(last, match.index));
    }
    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      out.push(<code key={key++} className="md-inline-code mono">{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") && token.endsWith("**")) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("[")) {
      const parts = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (parts) {
        out.push(
          <a key={key++} href={parts[2]} target="_blank" rel="noopener noreferrer" className="md-link">
            {parts[1]}
          </a>,
        );
      } else {
        out.push(token);
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
}
