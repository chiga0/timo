import { useMemo, useState } from "react";
import type { RunStreamEvent, TaskEvent } from "../api.js";
import { Markdown } from "./Markdown.js";

export interface LocalSteerItem {
  id: string;
  text: string;
  at: number;
  accepted: boolean;
  reason?: string;
}

interface ToolStep {
  id: string;
  kind: "shell" | "patch" | "read" | "tool" | "status";
  label: string;
  output?: string;
  at: number;
}

type TimelineBlock =
  | { kind: "work_group"; id: string; steps: ToolStep[]; startAt: number; endAt: number }
  | { kind: "prose"; id: string; text: string; at: number }
  | { kind: "error"; id: string; text: string; at: number };

const LIFECYCLE_NOISE_RE =
  /^(executor started|session started|agent started|agent settled|qwen-code started|qwen-code succeeded|codex started|codex succeeded|thread started|turn started|turn completed|result success|message_start|turn_start|turn_end|agent_end)/i;

/**
 * Codex-inspired chronological execution timeline for a single Task:
 * - Consecutive tool calls / patches / shell outputs collapse into clean
 *   work groups (`已执行 N 步 · 用时 Xs ▸`), auto-collapsed once finished.
 * - Tool calls absorb their immediately following `tool_result` so each tool
 *   invocation is one scannable line with on-demand output expansion.
 * - Agent updates and the final conclusion render as clean Markdown prose.
 */
export function TaskTimeline(props: {
  requestText?: string;
  status: string;
  isRunning: boolean;
  assistantText: string;
  failureReason?: string | null;
  runEvents: RunStreamEvent[];
  taskEvents: TaskEvent[];
  localSteers: LocalSteerItem[];
  hasActiveRun: boolean;
  onCopyConclusion?: () => void;
  copiedConclusion?: boolean;
}): React.JSX.Element {
  const [reqExpanded, setReqExpanded] = useState(false);

  const blocks = useMemo(
    () => buildTimelineBlocks(props.runEvents, props.assistantText),
    [props.runEvents, props.assistantText],
  );

  const requestText = props.requestText?.trim() ?? "";
  const isLongRequest = requestText.length > 220 || requestText.split("\n").length > 4;

  const lastBlockIndex = blocks.length - 1;

  return (
    <div className="tl-root">
      {/* User's original task brief as a clean right-aligned chat pill */}
      {requestText && (
        <div className="tl-user-wrap">
          <div className="tl-user-pill">
            <div className={isLongRequest && !reqExpanded ? "tl-user-text is-clamped" : "tl-user-text"}>
              {requestText}
            </div>
            {isLongRequest && (
              <button
                type="button"
                className="tl-user-more"
                onClick={() => setReqExpanded((v) => !v)}
              >
                {reqExpanded ? "收起需求" : "展开完整需求"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Structured Run Stream Timeline */}
      {props.hasActiveRun ? (
        blocks.length === 0 && !props.assistantText ? (
          props.isRunning ? (
            <div className="tl-thinking">
              <span className="dot dot-warning dot-pulse" />
              <span className="tl-shimmer">
                {props.status === "verifying" ? "正在独立环境中运行验收…" : "Thinking…"}
              </span>
            </div>
          ) : (
            <div className="empty-box">该次运行无结构化步骤记录</div>
          )
        ) : (
          <div className="tl-flow">
            {blocks.map((block, idx) => {
              if (block.kind === "work_group") {
                const isLatestActive = props.isRunning && idx === lastBlockIndex && !props.assistantText;
                return (
                  <WorkGroupBlock
                    key={block.id}
                    group={block}
                    defaultOpen={isLatestActive}
                    isActive={isLatestActive}
                  />
                );
              }
              if (block.kind === "error") {
                return (
                  <div key={block.id} className="tl-error-box">
                    <span className="dot dot-error" style={{ marginTop: 6, flexShrink: 0 }} />
                    <div className="tl-error-text">{block.text}</div>
                  </div>
                );
              }
              return (
                <div key={block.id} className="tl-prose">
                  <Markdown content={block.text} />
                </div>
              );
            })}
          </div>
        )
      ) : props.taskEvents.length > 0 && !props.assistantText ? (
        <WorkGroupBlock
          group={{
            kind: "work_group",
            id: "ledger-events",
            steps: props.taskEvents.map((ev) => ({
              id: ev.eventId,
              kind: "status",
              label: ev.type,
              at: Date.parse(ev.createdAt) || Date.now(),
            })),
            startAt: Date.parse(props.taskEvents[0]!.createdAt) || Date.now(),
            endAt: Date.parse(props.taskEvents[props.taskEvents.length - 1]!.createdAt) || Date.now(),
          }}
          defaultOpen={false}
          isActive={false}
        />
      ) : null}

      {/* Inline user steer messages sent during this session */}
      {props.localSteers.map((steer) => (
        <div key={steer.id} className="tl-user-wrap">
          <div className="tl-user-pill tl-steer-pill">
            <div className="tl-user-text">{steer.text}</div>
            <div className="tl-steer-meta">
              {steer.accepted ? "纠偏已送达" : `未送达：${steer.reason ?? "执行器不支持实时纠偏"}`}
            </div>
          </div>
        </div>
      ))}

      {/* Final Markdown Conclusion (natural end of the chat timeline) */}
      {props.assistantText && (
        <div className="tl-conclusion">
          <div className="tl-prose">
            <Markdown content={props.assistantText} />
          </div>
          {props.onCopyConclusion && (
            <div className="tl-conclusion-foot">
              <button type="button" className="btn-link" onClick={props.onCopyConclusion}>
                {props.copiedConclusion ? "已复制全文" : "复制 Markdown"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Failure summary if failed without assistant conclusion */}
      {!props.assistantText && props.status === "failed" && props.failureReason && (
        <div className="tl-error-box">
          <span className="dot dot-error" style={{ marginTop: 6, flexShrink: 0 }} />
          <div className="tl-error-text">{props.failureReason}</div>
        </div>
      )}

      {/* Subtle active thinking/verifying footer */}
      {props.isRunning && (blocks.length > 0 || props.assistantText) && (
        <div className="tl-thinking">
          <span className="dot dot-warning dot-pulse" />
          <span className="tl-shimmer">
            {props.status === "verifying" ? "正在独立环境中运行验收…" : "Thinking…"}
          </span>
        </div>
      )}
    </div>
  );
}

function WorkGroupBlock(props: {
  group: Extract<TimelineBlock, { kind: "work_group" }>;
  defaultOpen: boolean;
  isActive: boolean;
}): React.JSX.Element {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const [showAllSteps, setShowAllSteps] = useState(false);
  const open = userToggled !== null ? userToggled : props.defaultOpen;

  const steps = props.group.steps;
  const durationSec = Math.max(0, Math.round((props.group.endAt - props.group.startAt) / 1000));
  const patchCount = steps.filter((s) => s.kind === "patch").length;
  const label = buildGroupLabel(steps.length, patchCount, durationSec, props.isActive);

  // While actively streaming a long group, show the latest 6 steps cleanly with an expand option.
  const maxCollapsedLive = 6;
  const hiddenCount = props.isActive && !showAllSteps && steps.length > maxCollapsedLive ? steps.length - maxCollapsedLive : 0;
  const visibleSteps = hiddenCount > 0 ? steps.slice(hiddenCount) : steps;

  return (
    <div className={open ? "tl-group is-open" : "tl-group"}>
      <button
        type="button"
        className="tl-group-toggle"
        onClick={() => setUserToggled(!open)}
        aria-expanded={open}
      >
        <span className="tl-group-icon" aria-hidden="true">
          {props.isActive ? <span className="dot dot-warning dot-pulse" /> : "◎"}
        </span>
        <span className="tl-group-title">{label}</span>
        <span className="tl-chevron" aria-hidden="true">
          {open ? "⌄" : "›"}
        </span>
      </button>

      {open && (
        <div className="tl-steps">
          {hiddenCount > 0 && (
            <button
              type="button"
              className="tl-more-steps"
              onClick={() => setShowAllSteps(true)}
            >
              展开更早的 {hiddenCount} 步操作…
            </button>
          )}
          {visibleSteps.map((step) => (
            <ToolStepRow key={step.id} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolStepRow(props: { step: ToolStep }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = Boolean(props.step.output && props.step.output.trim() !== "");

  return (
    <div className="tl-step">
      <button
        type="button"
        className={hasOutput ? "tl-step-row is-clickable" : "tl-step-row"}
        disabled={!hasOutput}
        onClick={() => {
          if (hasOutput) setExpanded((v) => !v);
        }}
      >
        <span className={`tl-step-icon mono is-${props.step.kind}`} aria-hidden="true">
          {stepGlyph(props.step.kind)}
        </span>
        <span className="tl-step-label mono">{props.step.label}</span>
        {hasOutput && (
          <span className="tl-step-arrow" aria-hidden="true">
            {expanded ? "⌄" : "›"}
          </span>
        )}
      </button>
      {expanded && hasOutput && (
        <pre className="tl-step-out mono">{props.step.output}</pre>
      )}
    </div>
  );
}

function buildTimelineBlocks(events: RunStreamEvent[], finalAssistantText: string): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  let currentGroup: Extract<TimelineBlock, { kind: "work_group" }> | null = null;
  const normalizedFinal = finalAssistantText.trim();

  const flushGroup = () => {
    if (currentGroup && currentGroup.steps.length > 0) {
      blocks.push(currentGroup);
    }
    currentGroup = null;
  };

  const ensureGroup = (at: number, seq: number): Extract<TimelineBlock, { kind: "work_group" }> => {
    if (!currentGroup) {
      currentGroup = { kind: "work_group", id: `wg-${seq}`, steps: [], startAt: at, endAt: at };
    } else {
      currentGroup.endAt = Math.max(currentGroup.endAt, at);
    }
    return currentGroup;
  };

  for (const ev of events) {
    if (ev.type === "text_delta") continue;
    const rawSummary = ev.summary.trim();
    if (!rawSummary) continue;

    // Extract full text when adapter attached it (e.g. Pi / Codex)
    const dataObj = ev.data && typeof ev.data === "object" ? (ev.data as Record<string, unknown>) : null;
    const fullText = typeof dataObj?.fullText === "string" && dataObj.fullText.trim() !== "" ? dataObj.fullText.trim() : rawSummary;

    // Handle legacy `[toolResult]` / `[user]` status frames cleanly
    const isLegacyToolResult = ev.type === "status" && /^\[toolResult\]\s*/i.test(rawSummary);
    const isLegacyUserEcho = ev.type === "status" && /^\[user\]\s*/i.test(rawSummary);
    if (isLegacyUserEcho) continue;

    if (ev.type === "status" && !isLegacyToolResult && LIFECYCLE_NOISE_RE.test(rawSummary)) {
      continue;
    }

    if (ev.type === "error") {
      flushGroup();
      blocks.push({ kind: "error", id: `err-${ev.seq}`, text: fullText, at: ev.at });
      continue;
    }

    if (ev.type === "thinking") {
      // Skip if identical to the final conclusion rendered cleanly at the end
      if (normalizedFinal && (fullText === normalizedFinal || normalizedFinal.startsWith(fullText.slice(0, 120)))) {
        continue;
      }
      flushGroup();
      blocks.push({ kind: "prose", id: `prose-${ev.seq}`, text: fullText, at: ev.at });
      continue;
    }

    // Tool result attaches to the most recent step in the active work group
    if (ev.type === "tool_result" || isLegacyToolResult) {
      const cleanedOutput = isLegacyToolResult ? rawSummary.replace(/^\[toolResult\]\s*/i, "") : fullText;
      const grp = ensureGroup(ev.at, ev.seq);
      const prev = grp.steps[grp.steps.length - 1];
      if (prev && !prev.output) {
        prev.output = cleanedOutput;
      } else if (prev) {
        prev.output = `${prev.output}\n${cleanedOutput}`;
      } else {
        grp.steps.push({
          id: `step-${ev.seq}`,
          kind: "tool",
          label: firstLineClip(cleanedOutput, 84),
          output: cleanedOutput,
          at: ev.at,
        });
      }
      continue;
    }

    const grp = ensureGroup(ev.at, ev.seq);
    const kind = classifyStepKind(ev.type, rawSummary);
    const label = formatStepLabel(rawSummary);
    const extraOutput = rawSummary.length > 110 ? rawSummary : undefined;
    grp.steps.push({
      id: `step-${ev.seq}`,
      kind,
      label,
      output: extraOutput,
      at: ev.at,
    });
  }

  flushGroup();
  return blocks;
}

function classifyStepKind(type: RunStreamEvent["type"], summary: string): ToolStep["kind"] {
  if (type === "patch") return "patch";
  if (type === "shell") return "shell";
  const lower = summary.toLowerCase();
  if (/^(bash|shell|exec|run_command)[\s(:]/.test(lower)) return "shell";
  if (/^(read|grep|find|ls|glob|search|list)[\s(:]/.test(lower)) return "read";
  if (/^(edit|write|patch|modified)[\s(:]/.test(lower)) return "patch";
  if (type === "tool_call") return "tool";
  return "status";
}

function formatStepLabel(raw: string): string {
  // Turn `bash(cd /path && cmd)` or `read: path` into a clean scannable single line
  const cleaned = raw.replace(/\s+/g, " ").trim();
  const wrapped = cleaned.match(/^(?:bash|shell)\((.+)\)$/i);
  const inner = wrapped ? wrapped[1]!.trim() : cleaned;
  return inner.length > 110 ? `${inner.slice(0, 109)}…` : inner;
}

function firstLineClip(raw: string, max: number): string {
  const first = (raw.split(/\r?\n/)[0] ?? raw).trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

function stepGlyph(kind: ToolStep["kind"]): string {
  if (kind === "shell") return ">_";
  if (kind === "patch") return "✎";
  if (kind === "read") return "◎";
  if (kind === "tool") return "⚡";
  return "•";
}

function buildGroupLabel(stepCount: number, patchCount: number, durationSec: number, isActive: boolean): string {
  const parts: string[] = [];
  if (isActive) {
    parts.push(`正在执行（已完成 ${stepCount} 步）`);
  } else {
    parts.push(`已执行 ${stepCount} 步操作`);
  }
  if (patchCount > 0) {
    parts.push(`改动 ${patchCount} 处`);
  }
  if (durationSec > 0) {
    parts.push(`用时 ${formatDuration(durationSec)}`);
  }
  return parts.join(" · ");
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}
