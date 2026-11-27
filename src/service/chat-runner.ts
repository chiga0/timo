import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExecutorRegistry, RunStreamEvent } from "../adapters/execution.js";
import type { CapabilityMcpGateway } from "../gateway/mcp-gateway.js";
import { assembleTaskContext } from "../knowledge/context.js";
import type { SettingsStore } from "../settings.js";
import { parseSlashSkillInvocation, type SkillRegistry } from "../skills/registry.js";
import { MAX_ATTACHMENTS_PER_MESSAGE, type AttachmentStore, type ChatAttachment } from "../store/attachments.js";
import type { ChatMessage, ChatStore, ChatStreamBus } from "../store/chat.js";
import type { TaskService } from "./task-service.js";
import type { VerificationPlan } from "../verify/pipeline.js";
import { inspectLocalFolder, resolveValidBaseRef, selectFoldersForRequest } from "../workspace/inspect.js";
import { newId, toIso } from "../util.js";

export interface SendChatInput {
  text: string;
  executorId?: string;
  model?: string;
  mode?: "auto" | "repo_delivery" | "sse_log";
  sourcePath?: string;
  baseRef?: string;
  checkCommand?: string;
  maxRepairRounds?: number;
  attachmentIds?: string[];
}

export type SendChatResult =
  | { kind: "chat"; userMessage: ChatMessage; assistantMessage: ChatMessage }
  | { kind: "task"; userMessage: ChatMessage; taskCardMessage: ChatMessage; taskId: string };

/**
 * Orchestrates the fixed global Main Chat (`User <-> Timo Chief of Staff`).
 *
 * - Conversational questions, brainstorming, and status queries stream directly
 *   via a native `ExecutionAdapter` (never building a custom Agent Loop and
 *   never creating junk rows in `tasks`).
 * - Engineering requests that explicitly target a workspace repository (or
 *   log diagnosis) delegate a background `Task` via `TaskService` and insert a
 *   single live-updating `task_card` into Main Chat.
 */
export class MainChatRunner {
  private readonly activeTurns = new Map<string, { executorId: string; runId: string }>();

  constructor(
    private readonly deps: {
      home: string;
      chatStore: ChatStore;
      chatBus: ChatStreamBus;
      service: TaskService;
      executors?: ExecutorRegistry;
      settingsStore?: SettingsStore;
      skillRegistry?: SkillRegistry;
      attachments?: AttachmentStore;
      mcpGateway?: CapabilityMcpGateway;
      /** Optional per-turn wall-clock timeout in ms for Main Chat; undefined = unlimited (recommended). */
      chatTimeoutMs?: number;
      log?: (line: string) => void;
    },
  ) {}

  send(input: SendChatInput): SendChatResult {
    const resolvedAttachments: ChatAttachment[] = [];
    if (Array.isArray(input.attachmentIds) && input.attachmentIds.length > 0 && this.deps.attachments) {
      for (const rawId of input.attachmentIds.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
        const found = this.deps.attachments.get(rawId);
        if (found) resolvedAttachments.push(found);
      }
    }
    const rawText = input.text.trim();
    if (!rawText && resolvedAttachments.length === 0) {
      throw new Error("message text or attachment is required");
    }
    const text = rawText || (resolvedAttachments.some((a) => a.isImage) ? "请查看并分析这些图片/附件。" : "请查看并分析这些附件。");

    const settings = this.deps.settingsStore?.load();
    const chosenExecutor = input.executorId?.trim() || settings?.assistant.defaultExecutor || "qwen-code";
    const chosenModel = input.model?.trim() || settings?.assistant.executorModels[chosenExecutor] || undefined;

    // Settle any previous lingering streaming turn cleanly before starting a new user turn
    // so an older message never stays stuck with a blinking cursor.
    if (this.activeTurns.size > 0) {
      void this.stop();
    }

    const userMessage = this.deps.chatStore.append({
      role: "user",
      content: rawText,
      executorId: chosenExecutor,
      model: chosenModel ?? null,
      status: "done",
      attachments: resolvedAttachments,
    });
    this.deps.chatBus.publish({ event: "chat_message", data: userMessage });

    // Decide cleanly: delegate background Task OR reply directly in Main Chat.
    if (input.mode === "sse_log") {
      const created = this.deps.service.createTask({
        requestId: `chat-log-${newId()}`,
        kind: "sse_log",
        log: new TextEncoder().encode(text),
        requestText: text,
        executorId: chosenExecutor,
      });
      const taskCardMessage = this.deps.chatStore.append({
        role: "task_card",
        content: text,
        taskId: created.taskId,
        executorId: chosenExecutor,
        model: chosenModel ?? null,
        status: "done",
      });
      this.deps.chatBus.publish({ event: "chat_message", data: taskCardMessage });
      return { kind: "task", userMessage, taskCardMessage, taskId: created.taskId };
    }

    const explicitSource = input.sourcePath?.trim() ?? "";
    const isTimoMgmt = explicitSource === "" && isTimoManagementIntent(text);
    const matchedFolders = explicitSource || isTimoMgmt ? [] : selectFoldersForRequest(text, settings?.folders ?? []);
    const wantsRepoDelivery = explicitSource !== "" || (!isTimoMgmt && matchedFolders.length > 0 && hasDeliveryActionIntent(text));
    if (wantsRepoDelivery) {
      const repos = explicitSource
        ? [
            {
              sourcePath: explicitSource,
              baseRef: input.baseRef?.trim() || resolveValidBaseRef(explicitSource),
              name: explicitSource.replace(/\/+$/, "").split("/").at(-1) || "repo",
            },
          ]
        : matchedFolders.map((f) => ({
            sourcePath: f.path,
            baseRef: resolveValidBaseRef(f.path, f.baseRef),
            name: f.name,
          }));

      const checkCmd = input.checkCommand?.trim() ?? "";
      let verificationPlan: VerificationPlan;
      if (checkCmd) {
        verificationPlan = {
          version: "web-check-v1",
          steps: [{ type: "command_check", name: "verify", command: checkCmd, ...(repos.length === 1 ? { repo: repos[0]!.name } : {}) }],
        };
      } else if (explicitSource) {
        const detected = inspectLocalFolder(explicitSource).detectedCheckCommand;
        verificationPlan = {
          version: "auto-workspace-v1",
          steps: detected ? [{ type: "command_check", name: `verify-${repos[0]!.name}`, command: detected, repo: repos[0]!.name }] : [],
        };
      } else {
        const steps = matchedFolders
          .map((f) => ({ repo: f.name, cmd: f.checkCommand || inspectLocalFolder(f.path).detectedCheckCommand }))
          .filter((s): s is { repo: string; cmd: string } => Boolean(s.cmd))
          .map((s) => ({ type: "command_check" as const, name: `verify-${s.repo}`, command: s.cmd, repo: s.repo }));
        verificationPlan = { version: "auto-workspace-v1", steps };
      }

      const attachmentSection = this.formatAttachmentsSection(resolvedAttachments);
      const taskRequestText = attachmentSection ? `${text}\n\n${attachmentSection}` : text;
      const created = this.deps.service.createTask({
        requestId: `chat-task-${newId()}`,
        kind: "repo_delivery",
        requestText: taskRequestText,
        executorId: chosenExecutor,
        model: chosenModel,
        repos,
        verificationPlan,
        maxRepairRounds: input.maxRepairRounds ?? settings?.assistant.defaultMaxRepairRounds ?? 2,
      });
      const taskCardMessage = this.deps.chatStore.append({
        role: "task_card",
        content: text,
        taskId: created.taskId,
        executorId: chosenExecutor,
        model: chosenModel ?? null,
        status: "done",
      });
      this.deps.chatBus.publish({ event: "chat_message", data: taskCardMessage });
      return { kind: "task", userMessage, taskCardMessage, taskId: created.taskId };
    }

    // Heavy MR/PR code review URLs or explicit deep async reviews: delegate to a
    // managed background `review` worker (Task Card + Task Detail + Watchdog, no
    // artificial wall-clock timeout, Main Chat stays free for concurrent chat).
    if (!isTimoMgmt && hasHeavyReviewIntent(text)) {
      const repos = matchedFolders.map((f) => ({
        sourcePath: f.path,
        baseRef: resolveValidBaseRef(f.path, f.baseRef),
        name: f.name,
      }));
      const attachmentSection = this.formatAttachmentsSection(resolvedAttachments);
      const reviewRequestText = attachmentSection ? `${text}\n\n${attachmentSection}` : text;
      const created = this.deps.service.createTask({
        requestId: `chat-review-${newId()}`,
        kind: "review",
        requestText: reviewRequestText,
        executorId: chosenExecutor,
        model: chosenModel,
        repos,
      });
      const taskCardMessage = this.deps.chatStore.append({
        role: "task_card",
        content: text,
        taskId: created.taskId,
        executorId: chosenExecutor,
        model: chosenModel ?? null,
        status: "done",
      });
      this.deps.chatBus.publish({ event: "chat_message", data: taskCardMessage });
      return { kind: "task", userMessage, taskCardMessage, taskId: created.taskId };
    }

    // Conversational or read-only repo inquiry: stream directly in Main Chat (ZERO tasks created!).
    // If the user mentioned a single workspace folder for a read-only question
    // (e.g. "帮我看看 timo 仓库最新进展"), pass that folder as read-only cwd so the
    // CLI can inspect git log / docs directly and stream the answer in seconds.
    const readOnlyFolder = matchedFolders.length === 1 ? matchedFolders[0] : undefined;
    const assistantMessage = this.deps.chatStore.append({
      role: "assistant",
      content: "",
      executorId: chosenExecutor,
      model: chosenModel ?? null,
      status: "streaming",
    });
    this.deps.chatBus.publish({ event: "chat_message", data: assistantMessage });
    void this.runStreamingTurn(
      assistantMessage.messageId,
      text,
      chosenExecutor,
      chosenModel,
      readOnlyFolder?.path,
      resolvedAttachments,
    );
    return { kind: "chat", userMessage, assistantMessage };
  }

  async stop(messageId?: string): Promise<{ stopped: number }> {
    const targets = messageId
      ? [...this.activeTurns.entries()].filter(([id]) => id === messageId)
      : [...this.activeTurns.entries()];
    let stopped = 0;
    for (const [id, turn] of targets) {
      try {
        if (this.deps.executors?.has(turn.executorId)) {
          await this.deps.executors.require(turn.executorId).interrupt(turn.runId);
          stopped += 1;
        }
      } catch {
        // ignore interrupt errors
      }
      const existing = this.deps.chatStore.get(id);
      if (existing && existing.status === "streaming") {
        const updated = this.deps.chatStore.update(id, {
          content: existing.content || "（已停止生成）",
          status: "done",
          now: toIso(new Date()),
        });
        if (updated) this.deps.chatBus.publish({ event: "chat_done", data: updated });
      }
      this.activeTurns.delete(id);
    }
    return { stopped };
  }

  private async runStreamingTurn(
    messageId: string,
    userText: string,
    executorId: string,
    model?: string,
    readOnlyCwd?: string,
    attachments: ChatAttachment[] = [],
  ): Promise<void> {
    if (!this.deps.executors || !this.deps.executors.has(executorId)) {
      const updated = this.deps.chatStore.update(messageId, {
        content: `执行器 \`${executorId}\` 不可用，请在设置中检查代理状态或切换其他代理。`,
        status: "error",
      });
      if (updated) this.deps.chatBus.publish({ event: "chat_done", data: updated });
      return;
    }

    let adapter;
    try {
      adapter = this.deps.executors.require(executorId);
    } catch (error) {
      const updated = this.deps.chatStore.update(messageId, {
        content: `执行器 \`${executorId}\` 未就绪：${error instanceof Error ? error.message : String(error)}`,
        status: "error",
      });
      if (updated) this.deps.chatBus.publish({ event: "chat_done", data: updated });
      return;
    }

    const runId = `chat-${messageId.slice(0, 8)}-${newId().slice(0, 6)}`;
    const chatCwd = readOnlyCwd || join(this.deps.home, "chat-cwd");
    mkdirSync(chatCwd, { recursive: true, mode: 0o700 });
    const chiefToken = this.deps.mcpGateway?.issueChiefToken();
    const adapterDesc = this.deps.executors.snapshot().find((d) => d.id === adapter.id);
    const hasNativeMcp = Boolean(chiefToken && adapterDesc?.capabilities?.mcpGateway);
    const hasHttpBridge = Boolean(chiefToken && !hasNativeMcp);
    const prompt = this.buildChatPrompt(userText, messageId, readOnlyCwd, { hasNativeMcp, hasHttpBridge }, attachments);

    this.activeTurns.set(messageId, { executorId: adapter.id, runId });
    let accumulated = "";
    let firstStructuredError = "";
    let lastError = "";
    let lastPersistAt = 0;

    const handleEvent = (event: RunStreamEvent) => {
      if (!this.activeTurns.has(messageId)) return;
      if (event.type === "error" && event.summary.trim() !== "") {
        const msg = event.summary
          .replace(/Warning:\s*running headless with --yolo[\s\S]*?silence this notice\.?/gi, "")
          .trim();
        if (!msg) return;
        lastError = msg;
        if (!firstStructuredError && !/^Reading additional input from stdin/i.test(msg)) {
          firstStructuredError = msg;
        }
        return;
      }
      if (event.type === "tool_call" || event.type === "patch") {
        const summary = event.summary.trim();
        if (summary) {
          this.deps.chatBus.publish({
            event: "chat_step",
            data: { messageId, type: event.type, summary, at: event.at },
          });
        }
        return;
      }
      if (event.type === "text_delta" && event.summary.length > 0) {
        accumulated += event.summary;
        this.deps.chatBus.publish({
          event: "chat_delta",
          data: { messageId, delta: event.summary, content: accumulated },
        });
        const nowMs = Date.now();
        if (nowMs - lastPersistAt > 600) {
          lastPersistAt = nowMs;
          this.deps.chatStore.update(messageId, { content: accumulated, status: "streaming" });
        }
      } else if (event.type === "thinking" && accumulated === "" && event.summary.trim() !== "") {
        // Fallback for adapters that emit full assistant text only on message completion
        // (e.g. codex/opencode without token-level deltas).
        const data = event.data as { fullText?: string } | undefined;
        if (data?.fullText) {
          const delta = data.fullText.slice(accumulated.length);
          if (delta) {
            accumulated = data.fullText;
            this.deps.chatBus.publish({
              event: "chat_delta",
              data: { messageId, delta, content: accumulated },
            });
          }
        }
      }
    };

    const envTimeout = Number(process.env.TIMO_CHAT_TIMEOUT_MS);
    const chatTimeoutMs =
      this.deps.chatTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : undefined);

    try {
      let result = await adapter.spawn(
        {
          taskId: `chat:${messageId}`,
          runId,
          cwd: chatCwd,
          prompt,
          model,
          mcpGatewayUrl: chiefToken?.url,
          ...(chatTimeoutMs !== undefined ? { timeoutMs: chatTimeoutMs } : {}),
        },
        handleEvent,
      );
      if (!this.activeTurns.has(messageId)) return;

      // Chief-of-Staff self-healing: if a long deep-analysis/review turn hit its wall-clock
      // budget right before finishing and the runtime supports native session resume,
      // automatically resume ONCE instead of leaving the user stranded mid-sentence.
      let autoResumed = false;
      const hitTimeout =
        result.status === "timed_out" || /wall-clock budget .* exceeded|--max-wall-time/i.test(firstStructuredError || lastError);
      if (hitTimeout && adapterDesc?.capabilities?.resume && result.externalId) {
        autoResumed = true;
        this.deps.log?.(`chat turn ${messageId} hit wall-clock budget; auto-resuming session ${result.externalId}`);
        this.deps.chatBus.publish({
          event: "chat_step",
          data: {
            messageId,
            type: "status",
            summary: "耗时较长，正在自动续接上次会话进度继续完成…",
            at: Date.now(),
          },
        });
        firstStructuredError = "";
        lastError = "";
        const resumeRunId = `${runId}-resume`;
        this.activeTurns.set(messageId, { executorId: adapter.id, runId: resumeRunId });
        const beforeResumeLen = accumulated.length;
        if (accumulated.trim() !== "") {
          accumulated = `${accumulated.trimEnd()}\n\n`;
        }
        try {
          result = await adapter.resume(runId, handleEvent);
          // If resume returned final output without emitting deltas, append it cleanly.
          if (result.output?.trim() && accumulated.length <= beforeResumeLen + 2) {
            accumulated = `${accumulated}${result.output.trim()}`;
          }
        } catch (resumeErr) {
          lastError = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
        }
        if (!this.activeTurns.has(messageId)) return;
      }

      const errDetail = firstStructuredError || lastError;
      if (result.status !== "succeeded" && result.status !== "interrupted") {
        this.deps.log?.(`chat turn ${result.status} (${adapter.id}, ${messageId}): ${errDetail || `exit=${result.exitCode}`}`);
      }
      const friendlyErr =
        result.status === "timed_out"
          ? `执行器触发耗时上限${chatTimeoutMs ? `（${Math.round(chatTimeoutMs / 1000)}s）` : ""}，可点击下方「接着继续完成」延续上下文。`
          : errDetail;
      const finalContent =
        result.status === "succeeded"
          ? (autoResumed ? accumulated.trim() || result.output?.trim() : result.output?.trim() || accumulated.trim()) || "已完成处理。"
          : result.status === "interrupted"
            ? (accumulated.trim() || "（已停止生成）")
            : accumulated.trim()
              ? `${accumulated.trim()}\n\n> 生成中断（${result.status}${friendlyErr ? `：${friendlyErr}` : ""}）`
              : friendlyErr
                ? `执行器 \`${adapter.id}\` 调用失败（${result.status}）：\n\n> ${friendlyErr}\n\n可点击下方「重新执行」或切换其他模型或执行器后重试。`
                : `执行器 \`${adapter.id}\` 返回异常状态：${result.status}`;
      const updated = this.deps.chatStore.update(messageId, {
        content: finalContent,
        status: result.status === "succeeded" || result.status === "interrupted" ? "done" : "error",
      });
      if (updated) this.deps.chatBus.publish({ event: "chat_done", data: updated });
    } catch (error) {
      this.deps.log?.(`chat turn error (${messageId}): ${error instanceof Error ? error.message : String(error)}`);
      const updated = this.deps.chatStore.update(messageId, {
        content: accumulated.trim() || `调用 \`${adapter.id}\` 失败：${error instanceof Error ? error.message : String(error)}`,
        status: "error",
      });
      if (updated) this.deps.chatBus.publish({ event: "chat_done", data: updated });
    } finally {
      if (chiefToken) this.deps.mcpGateway?.revokeChief(chiefToken.nonce);
      this.activeTurns.delete(messageId);
    }
  }

  private buildChatPrompt(
    userText: string,
    currentAssistantMsgId: string,
    readOnlyCwd?: string,
    chiefAccess: { hasNativeMcp: boolean; hasHttpBridge: boolean } = { hasNativeMcp: false, hasHttpBridge: false },
    attachments: ChatAttachment[] = [],
  ): string {
    const settings = this.deps.settingsStore?.load();
    const allSkills = this.deps.skillRegistry ? this.deps.skillRegistry.list(settings) : undefined;
    const slashMatch = allSkills ? parseSlashSkillInvocation(userText, allSkills) : null;
    const invokedSkillBody =
      slashMatch && this.deps.skillRegistry ? this.deps.skillRegistry.readFull(slashMatch.skill.id, settings)?.body : undefined;

    const managedSkillsDir = this.deps.skillRegistry?.managedDir;
    const externalSkillSources = this.deps.skillRegistry?.discoverExternalSources() ?? [];

    const sections: string[] = [
      "你是 Timo（提莫），用户的本地个人研发总助理（Chief of Staff）。",
      "核心行事原则（默认自主推进、少打扰人）：",
      "- **直接行动，拒绝官僚式反复确认**：当用户已经表达明确意图（如「帮我搞定 / 帮我修复 / 托管 agent 完成 / 确认 / 全部搞定」）且不触及生产发布、合主干或删除数据等 Tier 2 红线时，**直接调用 `timo_delegate_task` 派发后台隔离 worktree 任务**（由后台执行器改代码并自动跑独立验收），不要再抛出“方案 A/B 选哪一个”“兼容策略请确认”之类的多余反问！只有在存在真正无法推断的业务歧义或红线风险时才向用户提问一次。",
      "- **代码改动走后台任务，禁止在主对话直接改业务仓库**：严禁在主对话直接编辑本地 Git 业务代码文件或创建 commit；需要改代码时，请用 `timo_delegate_task` 派发后台 worktree 任务，让用户在主对话实时看到任务卡进展并在后台自动完成独立验收。",
      ...(managedSkillsDir
        ? [
            `- **Skill 资产管理可直接就地完成**：当用户要求导入、新建或修正 Timo 统一 Skill 时，优先调用 \`timo_discover_external_skills\` / \`timo_import_skills\` / \`timo_save_skill\`，或直接脱敏维护 \`${managedSkillsDir}/<skill-id>/SKILL.md\`。`,
          ]
        : []),
      ...(readOnlyCwd
        ? [`- 本次对话的工作目录已定位到 \`${readOnlyCwd}\`，你可以直接只读查看其中的 git log、文档或代码文件来精准回答用户问题，但不要直接修改业务文件。`]
        : []),
    ];

    if ((chiefAccess.hasNativeMcp || chiefAccess.hasHttpBridge) && this.deps.mcpGateway) {
      const toolNames = this.deps.mcpGateway.listChiefToolNames();
      if (toolNames.length > 0) {
        const transportNote = chiefAccess.hasNativeMcp
          ? `你已通过原生 MCP 连接到运行中的 Timo 控制面（可用工具：${toolNames.map((n) => `\`${n}\``).join("、")}）。`
          : [
              `Timo 控制面正在运行，且已向当前进程环境变量注入 \`TIMO_MCP_GATEWAY_URL\`（可用工具：${toolNames.map((n) => `\`${n}\``).join("、")}）。`,
              "当前执行器未启用原生 MCP，请直接通过 bash 执行 HTTP POST 调用控制面工具（10ms 即时生效，严禁声称控制面未运行）：",
              "```bash",
              'curl -sS -X POST "$TIMO_MCP_GATEWAY_URL/call" -H "content-type: application/json" -d \'{"tool":"timo_delegate_task","args":{"requestText":"完整清晰的修复需求与验收标准","repoNames":["timo"]}}\'',
              "```",
            ].join("\n");
        sections.push(
          [
            "## Timo 控制面工具（Chief-of-Staff，已就绪）",
            transportNote,
            "- 派发后台代码修改/修复任务（`mode: \"repo_delivery\"`，自动建隔离 worktree + 独立验收）或长耗时只读 MR 评审/深度调研任务（`mode: \"review\"`，无硬超时且不阻塞主对话）→ `timo_delegate_task`（参数：`requestText`, 可选 `mode`, `repoNames`, `executorId`, `checkCommand`）；",
            "- 查询任意任务详情/验收日志/实时进展 → `timo_get_task_detail` / `timo_list_tasks` / `timo_list_inbox`；",
            "- 发现、查看、导入或保存 Timo 统一 Skill → `timo_discover_external_skills` / `timo_import_skills` / `timo_list_skills` / `timo_read_skill` / `timo_save_skill`；",
            "- 修改进行中任务的目标（两阶段 Diff 确认）→ `timo_propose_task_change`；",
            "- 重试失败任务或切换执行器交接（`g1 → g2`）→ `timo_retry_or_handoff_task`。",
          ].join("\n"),
        );
      }
    }

    if (externalSkillSources.length > 0 && managedSkillsDir) {
      sections.push(
        [
          `## 本机探测到的外部 Agent Skill 目录（可导入至 \`${managedSkillsDir}\`）`,
          ...externalSkillSources.map((src) => `- ${src.label}: \`${src.path}\`（共 ${src.skillCount} 个 Skill）`),
        ].join("\n"),
      );
    }

    if (settings) {
      const repoNames = readOnlyCwd
        ? (settings.folders ?? [])
            .filter((f) => f.path.replace(/\/+$/, "") === readOnlyCwd.replace(/\/+$/, ""))
            .map((f) => f.name)
        : [];
      const assembled = assembleTaskContext(settings, readOnlyCwd ? [readOnlyCwd] : [], {
        maxTotalBytes: 14 * 1024,
        maxFileBytes: 4 * 1024,
        maxFilesPerSource: 6,
        skills: allSkills,
        target: "chat",
        repoNames,
      });
      if (assembled.systemPrompt) {
        sections.push(`## 用户全局偏好\n${assembled.systemPrompt}`);
      }
      if (assembled.projectSummary) {
        sections.push(`## 已配置工作区与规则\n${assembled.projectSummary}`);
      }
      if (assembled.serviceCatalog) {
        sections.push(`## 已配置平台与服务目录（仅逻辑元信息，凭证隔离在网关）\n${assembled.serviceCatalog}`);
      }
      if (assembled.knowledgeSnippets.length > 0) {
        const docs = assembled.knowledgeSnippets
          .map((s) => `### ${s.filePath}${s.truncated ? " (truncated)" : ""}\n${s.content}`)
          .join("\n\n");
        sections.push(`## 本地知识库上下文（自动脱敏与限长装配）\n${docs}`);
      }
      if (assembled.skillsCatalog) {
        sections.push(assembled.skillsCatalog);
      }
    }

    if (slashMatch && invokedSkillBody) {
      sections.push(
        `## 用户显式调用的 Timo Skill：\`/${slashMatch.skill.id}\` (${slashMatch.skill.name})\n请严格遵循以下 Skill 指令完成本次请求：\n\n${invokedSkillBody}`,
      );
    }

    const activeTasks = this.deps.service.listTasks(15, undefined, { archived: "exclude" });
    const inbox = this.deps.service.listInbox();
    if (activeTasks.length > 0 || inbox.length > 0) {
      const taskLines = activeTasks
        .slice(0, 8)
        .map((t) => `- \`${t.taskId.slice(0, 8)}\` [${t.status}] ${t.title}${t.repoNames.length > 0 ? ` (${t.repoNames.join(", ")})` : ""}`);
      const inboxLines = inbox.slice(0, 5).map((i) => `- \`${i.taskId.slice(0, 8)}\` [${i.decisionKey}] ${i.title}: ${i.summary}`);
      sections.push(
        `## 当前后台任务与待处理概览\n` +
          (inboxLines.length > 0 ? `待我处理（${inbox.length}）：\n${inboxLines.join("\n")}\n` : "待我处理：0\n") +
          (taskLines.length > 0 ? `近期任务：\n${taskLines.join("\n")}` : "暂无后台任务"),
      );
    }

    // Recent multi-turn Main Chat memory: preserve the latest 2 turns generously
    // (up to 2,400 chars each) so Timo never forgets options/plans it just proposed!
    const history = this.deps.chatStore
      .list(24)
      .filter((m) => m.messageId !== currentAssistantMsgId && m.role !== "task_card" && m.content.trim() !== "")
      .slice(-9, -1);
    if (history.length > 0) {
      const total = history.length;
      sections.push(
        "## 最近主对话上下文\n" +
          history
            .map((m, idx) => {
              const limit = idx >= total - 2 ? 2400 : 800;
              const clipped = m.content.length > limit ? `${m.content.slice(0, limit)}…（已截断）` : m.content;
              return `${m.role === "user" ? "用户" : "Timo"}: ${clipped}`;
            })
            .join("\n\n"),
      );
    }

    const effectiveUserText = slashMatch ? (slashMatch.remainingText || `请按照 /${slashMatch.skill.id} 执行。`) : userText;
    const attachmentSection = this.formatAttachmentsSection(attachments);
    if (attachmentSection) {
      sections.push(attachmentSection);
    }
    sections.push(`## 用户最新消息\n${effectiveUserText}`);
    return sections.join("\n\n");
  }

  private formatAttachmentsSection(attachments: ChatAttachment[]): string {
    if (attachments.length === 0) return "";
    const blocks: string[] = [
      `## 用户随消息附带的图片与文件（共 ${attachments.length} 个）`,
      "这些附件已安全保存在本机只读路径中。如果是图片，请直接用你的图片/文件读取工具查看对应路径的图像内容后再作答；如果是文本/日志/代码文件，可直接读取原路径。",
    ];
    for (const att of attachments) {
      const kind = att.isImage ? "图片" : "文件";
      blocks.push(`- [${kind}] **${att.name}** (${att.mimeType}, ${att.sizeBytes} bytes) → 本机路径：\`${att.filePath}\``);
      const preview = this.deps.attachments?.readTextPreview(att);
      if (preview) {
        blocks.push(`\`\`\`\n${preview.text}\n\`\`\``);
      }
    }
    return blocks.join("\n");
  }
}

/**
 * Detects Timo control-plane / Skill management requests (e.g. "你能帮我导入这些 skill 吗？")
 * which MUST be handled directly in Main Chat rather than creating a Git repo worktree task.
 */
export function isTimoManagementIntent(text: string): boolean {
  const lowered = text.toLowerCase();
  const mentionsSkill = /\bskills?\b|技能/.test(lowered);
  const skillMgmtAction = /(导入|安装|同步|启用|停用|禁用|列出|查看|有哪些|管理|迁移|拷贝|复制|import|install|sync|enable|disable|list)/i.test(
    lowered,
  );
  if (mentionsSkill && skillMgmtAction) return true;
  if (/(帮我导入|能否导入|可以导入|导入.*skill|导入.*技能)/i.test(lowered)) return true;
  return false;
}

/**
 * Detects heavy MR/PR code review requests (with a codereview / pull / merge_requests URL)
 * that should be delegated to a managed background `review` worker so they run
 * asynchronously with Watchdog supervision, collapsible step timelines, and no blocking
 * of Main Chat.
 */
export function hasHeavyReviewIntent(text: string): boolean {
  const hasReviewUrl = /https?:\/\/[^\s]+\/(?:codereview|merge_requests|pull|pulls|reviews?)\/\d+/i.test(text);
  if (hasReviewUrl) return true;
  return false;
}

/**
 * Distinguishes actionable engineering delivery requests (modify/fix/implement/PR)
 * from read-only repository questions ("帮我看看 timo 最新进展").
 */
export function hasDeliveryActionIntent(text: string): boolean {
  const lowered = text.toLowerCase();
  return /(修复|修改|改动|改一下|改下|改掉|实现|开发|新增|添加|加上|补充|补齐|重构|优化|重写|删除|移除|去掉|清理|升级|迁移|接入|集成|提交|发\s*pr|提\s*pr|提\s*mr|写一个|写个|写单测|补单测|修一下|修个|\b(fix|implement|refactor|modify|edit|patch|rewrite|migrate|upgrade|add|create|write|remove|delete|open\s+pr|create\s+mr|commit)\b)/i.test(
    lowered,
  );
}
