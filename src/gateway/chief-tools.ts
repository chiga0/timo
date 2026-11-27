import type { CapabilityMcpGateway } from "./mcp-gateway.js";
import type { TaskService } from "../service/task-service.js";
import type { SettingsStore } from "../settings.js";
import type { ChatStore, ChatStreamBus } from "../store/chat.js";
import type { RunStreamStore } from "../workspace/run-stream.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { VerificationPlan } from "../verify/pipeline.js";
import { inspectLocalFolder, resolveValidBaseRef } from "../workspace/inspect.js";
import { newId } from "../util.js";

export interface ChiefToolsDeps {
  service: TaskService;
  settingsStore?: SettingsStore;
  skillRegistry?: SkillRegistry;
  chatStore?: ChatStore;
  chatBus?: ChatStreamBus;
  runStreams?: RunStreamStore;
  handoff?: (taskId: string, input: { executorId: string; model?: string; reason?: string }) => Promise<unknown>;
}

/**
 * Registers Timo Chief-of-Staff control-plane MCP tools strictly on `/mcp/chief/:nonce`.
 *
 * Design rules (`docs/architecture.md`):
 * - Read-only queries (`timo_list_tasks`, `timo_get_task_detail`, `timo_list_inbox`,
 *   `timo_list_skills`, `timo_read_skill`) execute immediately and never mutate state.
 * - Normal task delegation (`timo_delegate_task`) creates a background `repo_delivery`
 *   task inside Standing Policy and appends ONE live `task_card` into Main Chat.
 * - Sensitive mutations on existing tasks (`timo_propose_task_change`) follow
 *   two-phase Propose -> Commit, emitting a Diff confirmation card for human approval.
 * - Retry / Executor handoff (`timo_retry_or_handoff_task`) lets the Chief of Staff
 *   recover failed tasks or switch executors (`g1 -> g2`) on user request.
 */
export function registerChiefTools(gateway: CapabilityMcpGateway, deps: ChiefToolsDeps): void {
  gateway.registerChiefTool({
    name: "timo_list_tasks",
    description: "List Timo background engineering tasks with status, repos, executor, and result/failure summary.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional status filter (accepted|running|waiting|verifying|completed|failed|stopped)" },
        includeArchived: { type: "boolean", description: "Whether to include archived tasks (default false)" },
        limit: { type: "number", description: "Max tasks to return (default 20)" },
      },
    },
    handler: async (args) => {
      const status = typeof args.status === "string" && args.status.trim() !== "" ? args.status.trim() : undefined;
      const archived = args.includeArchived === true ? "all" : "exclude";
      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(100, Math.floor(args.limit)) : 20;
      const tasks = deps.service.listTasks(limit, status, { archived }).map((t) => ({
        taskId: t.taskId,
        title: t.title,
        status: t.status,
        waitingReason: t.waitingReason,
        executorId: t.executorId,
        repos: t.repoNames,
        archivedAt: t.archivedAt,
        resultSummaryPreview: t.resultSummary ? t.resultSummary.slice(0, 320) : null,
        failureReason: t.failureReason,
        updatedAt: t.updatedAt,
      }));
      return { data: { count: tasks.length, tasks } };
    },
  });

  gateway.registerChiefTool({
    name: "timo_get_task_detail",
    description: "Inspect full details of a specific Timo task: original request, repos/MR/CI, independent verification findings, final conclusion, and recent execution stream events.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Full or prefix Task ID" },
      },
      required: ["taskId"],
    },
    handler: async (args) => {
      const rawId = typeof args.taskId === "string" ? args.taskId.trim() : "";
      if (!rawId) return { isError: true, data: { code: "INVALID_INPUT", message: "taskId is required" } };
      const resolvedId = resolveTaskId(deps.service, rawId);
      if (!resolvedId) return { isError: true, data: { code: "NOT_FOUND", message: `task ${rawId} not found` } };
      const detail = deps.service.getTask(resolvedId);
      const runs = deps.runStreams?.listRuns(resolvedId) ?? [];
      const recentEvents =
        runs[0] && deps.runStreams
          ? deps.runStreams
              .read(resolvedId, runs[0], 0)
              .filter((e) => e.type !== "text_delta")
              .slice(-25)
              .map((e) => ({ seq: e.seq, type: e.type, summary: e.summary, at: new Date(e.at).toISOString() }))
          : [];
      return { data: { detail, runs, recentEvents } };
    },
  });

  gateway.registerChiefTool({
    name: "timo_list_inbox",
    description: "List all items currently in '待我处理' (pending human redline decisions, unrecoverable failures, unknown external effects).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const items = deps.service.listInbox();
      return { data: { count: items.length, items } };
    },
  });

  gateway.registerChiefTool({
    name: "timo_list_skills",
    description: "List Timo's unified executor-agnostic Skills catalog (managed in ~/.timo/skills and mounted external skill directories).",
    inputSchema: {
      type: "object",
      properties: {
        includeDisabled: { type: "boolean", description: "Include disabled skills (default true)" },
      },
    },
    handler: async (args) => {
      if (!deps.skillRegistry) return { data: { managedDir: null, count: 0, skills: [] } };
      const settings = deps.settingsStore?.load();
      const all = deps.skillRegistry.list(settings);
      const filtered = args.includeDisabled === false ? all.filter((s) => s.enabled) : all;
      return {
        data: {
          managedDir: deps.skillRegistry.managedDir,
          count: filtered.length,
          skills: filtered.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            scope: s.scope,
            enabled: s.enabled,
            source: s.source,
            sourceLabel: s.sourceLabel,
            filePath: s.filePath,
          })),
        },
      };
    },
  });

  gateway.registerChiefTool({
    name: "timo_read_skill",
    description: "Read the full Markdown instructions of a Timo-managed skill by id or name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill id or name (e.g. code-review)" },
      },
      required: ["name"],
    },
    handler: async (args) => {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return { isError: true, data: { code: "INVALID_INPUT", message: "name is required" } };
      if (!deps.skillRegistry) return { isError: true, data: { code: "UNSUPPORTED", message: "skill registry not configured" } };
      const found = deps.skillRegistry.readFull(name, deps.settingsStore?.load());
      if (!found) return { isError: true, data: { code: "NOT_FOUND", message: `skill '${name}' not found` } };
      return { data: { skill: found.skill, body: found.body } };
    },
  });

  gateway.registerChiefTool({
    name: "timo_discover_external_skills",
    description: "Discover skills installed in local agent runtimes (~/.qwen/skills, ~/.codex/skills, ~/.claude/skills, ~/.agents/skills, ~/.pi/agent/skills) that can be imported into Timo.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      if (!deps.skillRegistry) return { data: { sources: [] } };
      const sources = deps.skillRegistry.discoverExternalSources();
      return { data: { managedDir: deps.skillRegistry.managedDir, sources } };
    },
  });

  gateway.registerChiefTool({
    name: "timo_import_skills",
    description: "Import skills into Timo's unified managed directory (~/.timo/skills) with secret redaction. Pass either `sourceDir` (and optional `skillIds`) OR just `skillIds` to auto-locate and import matching skills across all local agent skill directories.",
    inputSchema: {
      type: "object",
      properties: {
        sourceDir: { type: "string", description: "Optional source skill directory path (omit to search all discovered local agent skill dirs)" },
        skillIds: {
          type: "array",
          items: { type: "string" },
          description: "Specific skill ids/names to import (omit with sourceDir to import all skills from sourceDir)",
        },
        overwrite: { type: "boolean", description: "Overwrite existing managed skill with same id (default false)" },
      },
    },
    handler: async (args) => {
      if (!deps.skillRegistry) return { isError: true, data: { code: "UNSUPPORTED", message: "skill registry not configured" } };
      const sourceDir = typeof args.sourceDir === "string" ? args.sourceDir.trim() : "";
      const skillIds = Array.isArray(args.skillIds)
        ? args.skillIds.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim())
        : [];
      const overwrite = args.overwrite === true;
      const settings = deps.settingsStore?.load();
      if (sourceDir) {
        const outcome = deps.skillRegistry.importFromDir(sourceDir, {
          skillIds: skillIds.length > 0 ? skillIds : undefined,
          overwrite,
        });
        return { data: { ...outcome, totalManaged: deps.skillRegistry.list(settings).length } };
      }
      if (skillIds.length === 0) {
        return {
          isError: true,
          data: { code: "INVALID_INPUT", message: "provide either sourceDir or a non-empty skillIds array" },
        };
      }
      const outcome = deps.skillRegistry.importByNames(skillIds, {
        overwrite,
        extraDirs: settings?.skillDirs,
      });
      return { data: { ...outcome, totalManaged: deps.skillRegistry.list(settings).length } };
    },
  });

  gateway.registerChiefTool({
    name: "timo_resync_skills",
    description:
      "Re-sync already-managed skills in ~/.timo/skills from their external source directories (managed copies are real copies, so upstream edits do not propagate automatically). Returns a per-skill diff summary (unchanged / updated / missing-source); pass dryRun to preview without writing.",
    inputSchema: {
      type: "object",
      properties: {
        sourceDirs: { type: "array", items: { type: "string" }, description: "Optional extra source skill dirs to search for matching skill ids" },
        skillIds: { type: "array", items: { type: "string" }, description: "Optional subset of managed skill ids/names to resync" },
        dryRun: { type: "boolean", description: "Only compute the diff summary, do not write (default false)" },
      },
    },
    handler: async (args) => {
      if (!deps.skillRegistry) return { isError: true, data: { code: "UNSUPPORTED", message: "skill registry not configured" } };
      const sourceDirs = Array.isArray(args.sourceDirs)
        ? args.sourceDirs.filter((d): d is string => typeof d === "string" && d.trim() !== "").map((d) => d.trim())
        : undefined;
      const skillIds = Array.isArray(args.skillIds)
        ? args.skillIds.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim())
        : undefined;
      const report = deps.skillRegistry.resyncManaged({
        sourceDirs,
        skillIds: skillIds && skillIds.length > 0 ? skillIds : undefined,
        dryRun: args.dryRun === true,
      });
      return { data: report };
    },
  });

  gateway.registerChiefTool({
    name: "timo_save_skill",
    description: "Create or update a Timo-managed skill in ~/.timo/skills/<id>/SKILL.md so it works across all executors.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Optional slug id" },
        name: { type: "string", description: "Skill name" },
        description: { type: "string", description: "One-line purpose summary" },
        content: { type: "string", description: "Full Markdown body instructions" },
        scope: { type: "string", description: "global | chat | task | repo:<name>" },
      },
      required: ["name", "description", "content"],
    },
    handler: async (args) => {
      if (!deps.skillRegistry) return { isError: true, data: { code: "UNSUPPORTED", message: "skill registry not configured" } };
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const description = typeof args.description === "string" ? args.description.trim() : "";
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!name || !description || !content) {
        return { isError: true, data: { code: "INVALID_INPUT", message: "name, description, and content are required" } };
      }
      const saved = deps.skillRegistry.saveManaged({
        id: typeof args.id === "string" ? args.id.trim() : undefined,
        name,
        description,
        content,
        scope: typeof args.scope === "string" ? args.scope.trim() : undefined,
      });
      return { data: { skill: saved } };
    },
  });

  gateway.registerChiefTool({
    name: "timo_delegate_task",
    description: "Create a background isolated-worktree engineering delivery task for one or more registered workspace Git repositories and post a single live Task Card into Main Chat.",
    inputSchema: {
      type: "object",
      properties: {
        requestText: { type: "string", description: "Clear engineering requirement or fix specification" },
        repoNames: {
          type: "array",
          items: { type: "string" },
          description: "Registered workspace folder names to mount in isolated git worktrees",
        },
        executorId: { type: "string", description: "Optional executor id (qwen-code|pi|codex|opencode)" },
        checkCommand: { type: "string", description: "Optional custom verification command" },
      },
      required: ["requestText", "repoNames"],
    },
    handler: async (args) => {
      const requestText = typeof args.requestText === "string" ? args.requestText.trim() : "";
      const repoNames = Array.isArray(args.repoNames)
        ? args.repoNames.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim())
        : [];
      if (!requestText || repoNames.length === 0) {
        return { isError: true, data: { code: "INVALID_INPUT", message: "requestText and non-empty repoNames are required" } };
      }
      const settings = deps.settingsStore?.load();
      const folders = settings?.folders ?? [];
      const matched = repoNames.map((name) => {
        const found = folders.find((f) => f.name.toLowerCase() === name.toLowerCase() || f.id.toLowerCase() === name.toLowerCase());
        return { name, folder: found };
      });
      const missing = matched.filter((m) => !m.folder).map((m) => m.name);
      if (missing.length > 0) {
        return {
          isError: true,
          data: {
            code: "REPO_NOT_REGISTERED",
            missing,
            availableFolders: folders.map((f) => f.name),
            message: `Unregistered workspace repos: ${missing.join(", ")}`,
          },
        };
      }
      const repos = matched.map((m) => {
        const f = m.folder!;
        return { sourcePath: f.path, baseRef: resolveValidBaseRef(f.path, f.baseRef), name: f.name };
      });
      const checkCmd = typeof args.checkCommand === "string" ? args.checkCommand.trim() : "";
      const verificationPlan: VerificationPlan = checkCmd
        ? {
            version: "chief-check-v1",
            steps: [{ type: "command_check", name: "verify", command: checkCmd, ...(repos.length === 1 ? { repo: repos[0]!.name } : {}) }],
          }
        : {
            version: "auto-workspace-v1",
            steps: matched
              .map((m) => ({ repo: m.folder!.name, cmd: m.folder!.checkCommand || inspectLocalFolder(m.folder!.path).detectedCheckCommand }))
              .filter((s): s is { repo: string; cmd: string } => Boolean(s.cmd))
              .map((s) => ({ type: "command_check" as const, name: `verify-${s.repo}`, command: s.cmd, repo: s.repo })),
          };

      const executorId =
        (typeof args.executorId === "string" && args.executorId.trim() !== "" ? args.executorId.trim() : undefined) ||
        settings?.assistant.defaultExecutor ||
        "qwen-code";
      const model = settings?.assistant.executorModels[executorId] || undefined;

      const created = deps.service.createTask({
        requestId: `chief-task-${newId()}`,
        kind: "repo_delivery",
        requestText,
        executorId,
        model,
        repos,
        verificationPlan,
        maxRepairRounds: settings?.assistant.defaultMaxRepairRounds ?? 2,
      });

      if (deps.chatStore && deps.chatBus) {
        const card = deps.chatStore.append({
          role: "task_card",
          content: requestText,
          taskId: created.taskId,
          executorId,
          model: model ?? null,
          status: "done",
        });
        deps.chatBus.publish({ event: "chat_message", data: card });
      }

      return {
        data: {
          taskId: created.taskId,
          status: created.status,
          executorId,
          repos: repos.map((r) => r.name),
        },
      };
    },
  });

  gateway.registerChiefTool({
    name: "timo_propose_task_change",
    description: "Two-phase Propose -> Commit: draft a goal/brief amendment Diff proposal card on an active task without mutating it until the user clicks confirm.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Full or prefix Task ID" },
        newGoal: { type: "string", description: "Proposed updated goal for the task" },
        reason: { type: "string", description: "Why this change is proposed" },
      },
      required: ["taskId", "newGoal"],
    },
    handler: async (args) => {
      const rawId = typeof args.taskId === "string" ? args.taskId.trim() : "";
      const newGoal = typeof args.newGoal === "string" ? args.newGoal.trim() : "";
      if (!rawId || !newGoal) {
        return { isError: true, data: { code: "INVALID_INPUT", message: "taskId and newGoal are required" } };
      }
      const resolvedId = resolveTaskId(deps.service, rawId);
      if (!resolvedId) return { isError: true, data: { code: "NOT_FOUND", message: `task ${rawId} not found` } };
      const current = deps.service.getBrief(resolvedId);
      const proposal = deps.service.proposeChange(resolvedId, {
        change: {
          kind: "brief",
          brief: { ...current, goal: newGoal },
          diff: [{ field: "goal", before: current.goal, after: newGoal }],
        },
        reason: typeof args.reason === "string" && args.reason.trim() !== "" ? args.reason.trim() : "chief-of-staff proposed goal amendment",
      });
      return { data: { proposal, note: "Diff proposal created; user must confirm in Task Detail page to take effect." } };
    },
  });

  gateway.registerChiefTool({
    name: "timo_retry_or_handoff_task",
    description: "Retry a failed/stopped/waiting task, or hand off an active repo_delivery task to another ready executor (g1 -> g2 immutable handoff).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Full or prefix Task ID" },
        action: { type: "string", enum: ["retry", "handoff"], description: "'retry' to re-run a failed/stopped task, or 'handoff' to switch executor" },
        executorId: { type: "string", description: "Target executor id (required for handoff, optional for retry)" },
        reason: { type: "string", description: "Optional reason for handoff" },
      },
      required: ["taskId", "action"],
    },
    handler: async (args) => {
      const rawId = typeof args.taskId === "string" ? args.taskId.trim() : "";
      const action = args.action === "handoff" ? "handoff" : args.action === "retry" ? "retry" : "";
      if (!rawId || !action) {
        return { isError: true, data: { code: "INVALID_INPUT", message: "taskId and action ('retry' | 'handoff') are required" } };
      }
      const resolvedId = resolveTaskId(deps.service, rawId);
      if (!resolvedId) return { isError: true, data: { code: "NOT_FOUND", message: `task ${rawId} not found` } };
      const executorId = typeof args.executorId === "string" && args.executorId.trim() !== "" ? args.executorId.trim() : undefined;
      if (action === "retry") {
        const res = deps.service.retryTask(resolvedId, { executorId });
        return { data: res };
      }
      if (!executorId) {
        return { isError: true, data: { code: "INVALID_INPUT", message: "executorId is required for handoff" } };
      }
      if (!deps.handoff) {
        return { isError: true, data: { code: "UNSUPPORTED", message: "handoff is not enabled on this server" } };
      }
      const res = await deps.handoff(resolvedId, {
        executorId,
        reason: typeof args.reason === "string" ? args.reason : "chief-of-staff handoff",
      });
      return { data: res };
    },
  });
}

function resolveTaskId(service: TaskService, idOrPrefix: string): string | null {
  try {
    service.getTask(idOrPrefix);
    return idOrPrefix;
  } catch {
    const tasks = service.listTasks(200, undefined, { archived: "all" });
    const matches = tasks.filter((t) => t.taskId.startsWith(idOrPrefix));
    return matches.length === 1 ? matches[0]!.taskId : null;
  }
}
