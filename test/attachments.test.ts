import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.js";
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from "../src/store/attachments.js";
import { ChatStore, ChatStreamBus } from "../src/store/chat.js";
import { TaskStore } from "../src/store/tasks.js";
import { ArtifactStore } from "../src/store/artifacts.js";
import { TaskService } from "../src/service/task-service.js";
import { TaskRunner } from "../src/service/runner.js";
import { MainChatRunner } from "../src/service/chat-runner.js";
import { ExecutorRegistry, type ExecutionAdapter } from "../src/adapters/execution.js";
import { Router } from "../src/http/server.js";
import { registerApi } from "../src/http/routes.js";

async function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "timo-attachments-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1x1 transparent PNG
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("Chat Attachments: storage, safety, persistence and prompt injection", () => {
  it("saves images & text files with 0600 isolation, blocks traversal, redacts text preview, and deletes cleanly", async () => {
    await withTempDir((dir) => {
      const store = new AttachmentStore(dir);

      const img = store.saveBase64({
        name: "../../evil/screenshot.png",
        mimeType: "image/png",
        dataBase64: TINY_PNG_BASE64,
      });
      assert.equal(img.name, "screenshot.png");
      assert.equal(img.isImage, true);
      assert.ok(img.filePath.startsWith(store.dir));
      assert.ok(existsSync(img.filePath));
      assert.equal(store.get("../etc/passwd"), null);
      assert.equal(store.readTextPreview(img), null, "images should not be inline-previewed as text");

      const logFile = store.saveBase64({
        name: "error.log",
        mimeType: "text/plain",
        dataBase64: Buffer.from("ERROR token=sk-live-secret-1234567890 failed\n", "utf8").toString("base64"),
      });
      assert.equal(logFile.isImage, false);
      const preview = store.readTextPreview(logFile);
      assert.ok(preview);
      assert.match(preview.text, /ERROR/);
      assert.doesNotMatch(preview.text, /sk-live-secret-1234567890/);

      // SVG is NOT treated as inline image (XSS prevention)
      const svg = store.saveBase64({
        name: "icon.svg",
        mimeType: "image/svg+xml",
        dataBase64: Buffer.from("<svg><script>alert(1)</script></svg>", "utf8").toString("base64"),
      });
      assert.equal(svg.isImage, false);

      // Oversized attachment is rejected
      const tooBig = Buffer.alloc(MAX_ATTACHMENT_BYTES + 16, 0x41).toString("base64");
      assert.throws(() => store.saveBase64({ name: "huge.bin", mimeType: "application/octet-stream", dataBase64: tooBig }), /limit/);

      // Delete removes disk file and metadata
      assert.equal(store.delete(img.id), true);
      assert.equal(existsSync(img.filePath), false);
      assert.equal(store.get(img.id), null);
    });
  });

  it("persists attachments on chat messages, allows image-only send, and injects local paths + redacted text into executor prompt", async () => {
    await withTempDir(async (dir) => {
      const { service, db, bus, writer } = TaskService.open(defaultConfig({}, dir));
      const chatStore = new ChatStore(db);
      const chatBus = new ChatStreamBus();
      const attachments = new AttachmentStore(dir);

      let capturedPrompt = "";
      const fakeAdapter: ExecutionAdapter = {
        id: "fake-exec",
        probe: async () => ({
          id: "fake-exec",
          kind: "cli",
          available: true,
          capabilities: { streaming: true, steer: false, mcpGateway: false, handoff: false, structuredOutput: false },
        }),
        spawn: async (req) => {
          capturedPrompt = req.prompt;
          return { runId: req.runId, externalId: null, status: "succeeded", output: "已查看截图和日志。", exitCode: 0 };
        },
        resume: async (runId) => ({ runId, externalId: null, status: "failed", output: "", exitCode: 1 }),
        steer: async () => ({ accepted: false }),
        interrupt: async () => ({ interrupted: true }),
      };
      const executors = new ExecutorRegistry();
      executors.register(fakeAdapter);
      await executors.probeAll();

      const chatRunner = new MainChatRunner({
        home: dir,
        chatStore,
        chatBus,
        service,
        executors,
        attachments,
      });

      const router = new Router();
      registerApi(router, {
        service,
        ledger: writer.ledger,
        bus,
        startedAt: new Date().toISOString(),
        t3Configured: false,
        chatStore,
        attachments,
        chatBus,
        chatRunner,
      });

      const callApi = async (method: string, path: string, body?: unknown) => {
        const match = await router.dispatch({
          method,
          path,
          query: new URLSearchParams(),
          params: {},
          body,
          accept: "application/json",
          trustedLocal: true,
        });
        assert.ok(match);
        return match.route.handler({
          method,
          path,
          query: new URLSearchParams(),
          params: match.params,
          body,
          accept: "application/json",
          trustedLocal: true,
        });
      };

      try {
        // Upload one screenshot and one log file via HTTP route
        const imgRes = await callApi("POST", "/api/attachments", {
          name: "ui-bug.png",
          mimeType: "image/png",
          dataBase64: TINY_PNG_BASE64,
        });
        assert.equal(imgRes.status, 201);
        const imgAtt = (imgRes.body as { attachment: { id: string; filePath: string } }).attachment;

        const txtRes = await callApi("POST", "/api/attachments", {
          name: "trace.txt",
          mimeType: "text/plain",
          dataBase64: Buffer.from("line 1: timeout\n", "utf8").toString("base64"),
        });
        const txtAtt = (txtRes.body as { attachment: { id: string; filePath: string } }).attachment;

        // Send message with empty text + two attachments
        const sendRes = await callApi("POST", "/api/chat/send", {
          text: "",
          executorId: "fake-exec",
          attachmentIds: [imgAtt.id, txtAtt.id],
        });
        assert.equal(sendRes.status, 201);
        const sent = sendRes.body as { kind: string; userMessage: { attachments?: Array<{ id: string }> } };
        assert.equal(sent.kind, "chat");
        assert.equal(sent.userMessage.attachments?.length, 2);

        // Wait briefly for async spawn to capture prompt
        await new Promise((r) => setTimeout(r, 40));
        assert.ok(capturedPrompt.includes(imgAtt.filePath), "executor prompt must include local image path");
        assert.ok(capturedPrompt.includes(txtAtt.filePath), "executor prompt must include local text file path");
        assert.ok(capturedPrompt.includes("line 1: timeout"), "executor prompt should inline small UTF-8 file preview");

        // Reloading chat messages preserves attachments from SQLite
        const listed = chatStore.list(20);
        const persistedUser = listed.find((m) => m.role === "user");
        assert.equal(persistedUser?.attachments?.length, 2);
        assert.equal(persistedUser?.attachments?.[0]?.name, "ui-bug.png");
      } finally {
        service.close();
      }
    });
  });

  it("streams live chat_step tool progress and auto-resumes Main Chat once on wall-clock timeout", async () => {
    await withTempDir(async (dir) => {
      const { service, db } = TaskService.open(defaultConfig({}, dir));
      const chatStore = new ChatStore(db);
      const chatBus = new ChatStreamBus();
      const observedSteps: Array<{ type: string; summary: string }> = [];
      let doneContent = "";
      let doneStatus = "";
      chatBus.subscribe((frame) => {
        if (frame.event === "chat_step") observedSteps.push({ type: frame.data.type, summary: frame.data.summary });
        if (frame.event === "chat_done") {
          doneContent = frame.data.content;
          doneStatus = frame.data.status;
        }
      });

      let resumedCalls = 0;
      const resumableAdapter: ExecutionAdapter = {
        id: "resumable-exec",
        probe: async () => ({
          id: "resumable-exec",
          kind: "cli",
          available: true,
          capabilities: { streaming: true, resume: true, steer: true, mcpGateway: false, handoff: false, structuredOutput: false },
        }),
        spawn: async (req, onEvent) => {
          onEvent({ seq: 1, runId: req.runId, taskId: req.taskId, type: "tool_call", at: Date.now(), summary: "bash(git diff --stat)" });
          onEvent({ seq: 2, runId: req.runId, taskId: req.taskId, type: "text_delta", at: Date.now(), summary: "已完成第一阶段审查。" });
          onEvent({
            seq: 3,
            runId: req.runId,
            taskId: req.taskId,
            type: "error",
            at: Date.now(),
            summary: "Warning: running headless with --yolo and no sandbox. or set QWEN_CODE_SUPPRESS_YOLO_WARNING=1 to silence this notice. Run aborted: wall-clock budget of 120s exceeded (--max-wall-time).",
          });
          return { runId: req.runId, externalId: "sess-123", status: "timed_out", exitCode: 1, output: "" };
        },
        resume: async (runId, onEvent) => {
          resumedCalls += 1;
          onEvent({ seq: 4, runId, taskId: "chat:resume", type: "tool_call", at: Date.now(), summary: "read(final-check.ts)" });
          onEvent({ seq: 5, runId, taskId: "chat:resume", type: "text_delta", at: Date.now(), summary: "最终结论：全部校验通过。" });
          return { runId: `${runId}-resume`, externalId: "sess-123", status: "succeeded", exitCode: 0, output: "最终结论：全部校验通过。" };
        },
        steer: async () => ({ accepted: false }),
        interrupt: async () => ({ interrupted: true }),
      };

      const executors = new ExecutorRegistry();
      executors.register(resumableAdapter);
      await executors.probeAll();

      const chatRunner = new MainChatRunner({
        home: dir,
        chatStore,
        chatBus,
        service,
        executors,
        chatTimeoutMs: 600_000,
      });

      try {
        chatRunner.send({ text: "帮我深度评审这个 85 文件的 MR", executorId: "resumable-exec" });
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(resumedCalls, 1, "should automatically resume once on timeout");
        assert.equal(doneStatus, "done");
        assert.match(doneContent, /已完成第一阶段审查/);
        assert.match(doneContent, /最终结论：全部校验通过/);
        assert.ok(observedSteps.some((s) => s.summary.includes("git diff --stat")));
        assert.ok(observedSteps.some((s) => s.summary.includes("自动续接")));
        assert.ok(observedSteps.some((s) => s.summary.includes("final-check.ts")));
      } finally {
        service.close();
      }
    });
  });

  it("imposes no artificial wall-clock timeout by default and delegates MR/PR review URLs to background review tasks", async () => {
    await withTempDir(async (dir) => {
      const cfg = defaultConfig({}, dir);
      assert.equal(cfg.runDeadlineMs, 0, "defaultConfig should not impose an arbitrary 120s kill limit");

      const { service, db } = TaskService.open(cfg);
      const chatStore = new ChatStore(db);
      const chatBus = new ChatStreamBus();

      let seenTimeoutMs: number | undefined = -1;
      const fakeAdapter: ExecutionAdapter = {
        id: "no-timeout-exec",
        probe: async () => ({
          id: "no-timeout-exec",
          kind: "cli",
          available: true,
          capabilities: { streaming: true, resume: false, steer: false, mcpGateway: false, handoff: false, structuredOutput: false },
        }),
        spawn: async (req) => {
          seenTimeoutMs = req.timeoutMs;
          return { runId: req.runId, externalId: null, status: "succeeded", output: "ok", exitCode: 0 };
        },
        resume: async (runId) => ({ runId, externalId: null, status: "failed", output: "", exitCode: 1 }),
        steer: async () => ({ accepted: false }),
        interrupt: async () => ({ interrupted: true }),
      };

      const executors = new ExecutorRegistry();
      executors.register(fakeAdapter);
      await executors.probeAll();

      const chatRunner = new MainChatRunner({
        home: dir,
        chatStore,
        chatBus,
        service,
        executors,
      });

      try {
        // 1. Regular chat turn must not pass any artificial timeoutMs
        chatRunner.send({ text: "帮我解释一下这个设计原则", executorId: "no-timeout-exec" });
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(seenTimeoutMs, undefined, "Main Chat should not impose an artificial timeoutMs by default");

        // 2. Heavy MR/PR review URL delegates cleanly to a background managed `review` task
        const reviewRes = chatRunner.send({
          text: "帮我review: https://code.example.com/org/demo-repo/codereview/31525692",
          executorId: "no-timeout-exec",
        });
        assert.equal(reviewRes.kind, "task");
        if (reviewRes.kind === "task") {
          const detail = service.getTask(reviewRes.taskId);
          assert.equal(detail.kind, "review");
          assert.equal(reviewRes.taskCardMessage.role, "task_card");
        }
      } finally {
        service.close();
      }
    });
  });

  it("TaskRunner provisions an isolated TMPDIR for review tasks, forbids ask_user_question, and cleans up TMPDIR deterministically", async () => {
    await withTempDir(async (dir) => {
      const cfg = defaultConfig({}, dir);
      const { service, db, bus, writer } = TaskService.open(cfg);
      const store = new TaskStore(db);
      const artifacts = ArtifactStore.create(dir);

      let capturedPrompt = "";
      let capturedTmpDir = "";
      let createdScratchFile = "";
      const reviewAdapter: ExecutionAdapter = {
        id: "review-exec",
        probe: async () => ({
          id: "review-exec",
          kind: "cli",
          available: true,
          capabilities: { streaming: true, resume: false, steer: false, mcpGateway: false, handoff: false, structuredOutput: false },
        }),
        spawn: async (req) => {
          capturedPrompt = req.prompt;
          capturedTmpDir = req.env?.TMPDIR ?? "";
          if (capturedTmpDir) {
            createdScratchFile = join(capturedTmpDir, "mr-clone.txt");
            writeFileSync(createdScratchFile, "temporary clone artifact", "utf8");
          }
          return { runId: req.runId, externalId: null, status: "succeeded", output: "# 评审完成\n一切正常。", exitCode: 0 };
        },
        resume: async (runId) => ({ runId, externalId: null, status: "failed", output: "", exitCode: 1 }),
        steer: async () => ({ accepted: false }),
        interrupt: async () => ({ interrupted: true }),
      };

      const executors = new ExecutorRegistry();
      executors.register(reviewAdapter);
      await executors.probeAll();

      const runner = new TaskRunner({
        store,
        service,
        artifacts,
        writer,
        bus,
        t3: null,
        clientFactory: () => {
          throw new Error("unused");
        },
        pollIntervalMs: 50,
        waitTimeoutMs: 1000,
        runDeadlineMs: cfg.runDeadlineMs,
        executors,
        log: () => undefined,
      });

      try {
        const created = service.createTask({
          requestId: "review-tmpdir-test",
          kind: "review",
          requestText: "评审 MR 42",
          executorId: "review-exec",
        });
        await runner.runOnce();
        const detail = service.getTask(created.taskId);
        assert.equal(detail.status, "completed");
        assert.ok(capturedPrompt.includes("ask_user_question"), "review prompt must explicitly forbid ask_user_question");
        assert.ok(capturedTmpDir.length > 0, "review worker must receive isolated TMPDIR");
        assert.ok(capturedPrompt.includes(capturedTmpDir), "review prompt must point worker to $TMPDIR");
        assert.equal(existsSync(createdScratchFile), false, "scratch files inside $TMPDIR must be auto-cleaned");
        assert.equal(existsSync(capturedTmpDir), false, "isolated review TMPDIR must be removed after completion");
      } finally {
        service.close();
      }
    });
  });
});
