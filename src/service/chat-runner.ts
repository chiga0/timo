import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExecutorRegistry, RunStreamEvent } from "../adapters/execution.js";
import type { CapabilityMcpGateway } from "../gateway/mcp-gateway.js";
import { assembleTaskContext } from "../knowledge/context.js";
import type { SettingsStore } from "../settings.js";
import { parseSlashSkillInvocation, type SkillRegistry } from "../skills/registry.js";
import type { ChatMessage, ChatStore, ChatStreamBus } from "../store/chat.js";
import type { TaskService } from "./task-service.js";
import type { VerificationPlan } from "../verify/pipeline.js";
import { inspectLocalFolder, selectFoldersForRequest } from "../workspace/inspect.js";
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
      mcpGateway?: CapabilityMcpGateway;
      log?: (line: string) => void;
    },
  ) {}

  send(input: SendChatInput): SendChatResult {
    const text = input.text.trim();
    if (!text) throw new Error("message text is required");

    const settings = this.deps.settingsStore?.load();
    const chosenExecutor = input.executorId?.trim() || settings?.assistant.defaultExecutor || "qwen-code";
    const chosenModel = input.model?.trim() || settings?.assistant.executorModels[chosenExecutor] || undefined;

    const userMessage = this.deps.chatStore.append({
      role: "user",
      content: text,
      executorId: chosenExecutor,
      model: chosenModel ?? null,
      status: "done",
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
    const matchedFolders = explicitSource ? [] : selectFoldersForRequest(text, settings?.folders ?? []);
    const wantsRepoDelivery = explicitSource !== "" || (matchedFolders.length > 0 && hasDeliveryActionIntent(text));
    if (wantsRepoDelivery) {
      const repos = explicitSource
        ? [
            {
              sourcePath: explicitSource,
              baseRef: input.baseRef?.trim() || inspectLocalFolder(explicitSource).baseRef || "main",
              name: explicitSource.replace(/\/+$/, "").split("/").at(-1) || "repo",
            },
          ]
        : matchedFolders.map((f) => {
            const inspected = inspectLocalFolder(f.path);
            return {
              sourcePath: f.path,
              baseRef: f.baseRef || inspected.baseRef || "main",
              name: f.name,
            };
          });

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

      const created = this.deps.service.createTask({
        requestId: `chat-task-${newId()}`,
        kind: "repo_delivery",
        requestText: text,
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
    void this.runStreamingTurn(assistantMessage.messageId, text, chosenExecutor, chosenModel, readOnlyFolder?.path);
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
    const prompt = this.buildChatPrompt(userText, messageId, readOnlyCwd, Boolean(chiefToken));

    this.activeTurns.set(messageId, { executorId: adapter.id, runId });
    let accumulated = "";
    let lastPersistAt = 0;

    const handleEvent = (event: RunStreamEvent) => {
      if (!this.activeTurns.has(messageId)) return;
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

    try {
      const result = await adapter.spawn(
        {
          taskId: `chat:${messageId}`,
          runId,
          cwd: chatCwd,
          prompt,
          model,
          mcpGatewayUrl: chiefToken?.url,
          timeoutMs: 120_000,
        },
        handleEvent,
      );
      if (!this.activeTurns.has(messageId)) return;
      const finalContent =
        result.status === "succeeded"
          ? (result.output?.trim() || accumulated.trim() || "已完成处理。")
          : result.status === "interrupted"
            ? (accumulated.trim() || "（已停止生成）")
            : accumulated.trim()
              ? `${accumulated.trim()}\n\n> 生成中断（${result.status}）`
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

  private buildChatPrompt(userText: string, currentAssistantMsgId: string, readOnlyCwd?: string, hasChiefMcp = false): string {
    const settings = this.deps.settingsStore?.load();
    const allSkills = this.deps.skillRegistry ? this.deps.skillRegistry.list(settings) : undefined;
    const slashMatch = allSkills ? parseSlashSkillInvocation(userText, allSkills) : null;
    const invokedSkillBody =
      slashMatch && this.deps.skillRegistry ? this.deps.skillRegistry.readFull(slashMatch.skill.id, settings)?.body : undefined;

    const sections: string[] = [
      "你是 Timo（提莫），用户的本地个人研发总助理（Chief of Staff）。",
      "当前处于「主对话」会话中：请用简洁、清晰的中文 Markdown 直接回答用户问题；严禁在主对话中直接修改本地代码文件、严禁创建 commit、严禁运行耗时的全量测试或破坏性命令。",
      ...(readOnlyCwd
        ? [`本次对话的工作目录已定位到 \`${readOnlyCwd}\`，你可以直接只读查看其中的 git log、文档或代码文件来精准回答用户问题，但不要修改任何文件。`]
        : ["当用户明确要求开发、修复或修改某个工作区仓库代码时，可通过 `timo_delegate_task` 或系统自动路由创建后台独立 Worktree 交付任务；否则你只需直接给出高质量回答或建议。"]),
    ];

    if (hasChiefMcp && this.deps.mcpGateway) {
      const toolNames = this.deps.mcpGateway.listChiefToolNames();
      if (toolNames.length > 0) {
        sections.push(
          [
            "## Timo 控制面工具（Chief-of-Staff MCP，已挂载）",
            `你已连接到 Timo 本地控制面 MCP（可用工具：${toolNames.map((n) => `\`${n}\``).join("、")}）：`,
            "- 查询任意任务详情/验收日志/实时进展 → 调用 `timo_get_task_detail` / `timo_list_tasks` / `timo_list_inbox`；",
            "- 查看或读取 Timo 统一 Skill → 调用 `timo_list_skills` / `timo_read_skill`；",
            "- 用户明确要求派发代码改动任务 → 调用 `timo_delegate_task`（自动建隔离 worktree 并在主对话插入单张任务卡）；",
            "- 用户要求修改进行中任务的目标 → 调用 `timo_propose_task_change`（生成两阶段 Diff 确认卡，由人拍板生效）；",
            "- 用户要求重试失败任务或切换执行器交接 → 调用 `timo_retry_or_handoff_task`。",
          ].join("\n"),
        );
      }
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

    // Recent multi-turn Main Chat memory (last 8 messages before the current turn).
    const history = this.deps.chatStore
      .list(24)
      .filter((m) => m.messageId !== currentAssistantMsgId && m.role !== "task_card" && m.content.trim() !== "")
      .slice(-9, -1);
    if (history.length > 0) {
      sections.push(
        "## 最近主对话上下文\n" +
          history
            .map((m) => `${m.role === "user" ? "用户" : "Timo"}: ${m.content.slice(0, 400)}`)
            .join("\n"),
      );
    }

    const effectiveUserText = slashMatch ? (slashMatch.remainingText || `请按照 /${slashMatch.skill.id} 执行。`) : userText;
    sections.push(`## 用户最新消息\n${effectiveUserText}`);
    return sections.join("\n\n");
  }
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
