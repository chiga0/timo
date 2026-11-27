import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QwenCodeAdapter } from "../src/adapters/qwen-code.js";
import type { RunStreamEvent } from "../src/adapters/execution.js";

function fakeQwen(dir: string, script: string): string {
  const path = join(dir, "fake-qwen.sh");
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return path;
}

test("QwenCodeAdapter streams assistant/tool/patch/result JSONL and mounts MCP gateway httpUrl", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timo-qwen-"));
  const cwd = mkdtempSync(join(tmpdir(), "timo-qwen-cwd-"));
  const argsFile = join(dir, "args.txt");
  try {
    const cli = fakeQwen(
      dir,
      [
        `printf '%s\n' "$@" > "${argsFile}"`,
        "read -r first_line",
        `echo '{"type":"system","subtype":"init","session_id":"qwen-sess-1","model":"qwen3-coder","qwen_code_version":"0.25.3"}'`,
        `echo '{"type":"assistant","session_id":"qwen-sess-1","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"edit","input":{"file_path":"src/demo.ts"}}]}}'`,
        `echo '{"type":"user","session_id":"qwen-sess-1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"ok"}]}}'`,
        `echo '{"type":"assistant","session_id":"qwen-sess-1","message":{"role":"assistant","content":[{"type":"text","text":"已完成修改"}]}}'`,
        `echo '{"type":"result","subtype":"success","session_id":"qwen-sess-1","is_error":false,"num_turns":1,"result":"已完成修改"}'`,
        "exit 0",
      ].join("\n"),
    );

    const adapter = new QwenCodeAdapter({ command: cli });
    const events: RunStreamEvent[] = [];
    const result = await adapter.spawn(
      {
        taskId: "t-qwen-1",
        runId: "r-qwen-1",
        cwd,
        prompt: "fix demo",
        mcpGatewayUrl: "http://127.0.0.1:4321/mcp/t-qwen-1/1/nonce1",
      },
      (ev) => events.push(ev),
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.externalId, "qwen-sess-1");
    assert.equal(result.output, "已完成修改");
    assert.ok(events.some((e) => e.type === "tool_call" && e.summary.includes("src/demo.ts")));
    assert.ok(events.some((e) => e.type === "patch" && e.summary.includes("src/demo.ts")));
    assert.ok(events.some((e) => e.type === "tool_result"));

    const { readFileSync } = await import("node:fs");
    const passedArgs = readFileSync(argsFile, "utf8");
    assert.match(passedArgs, /--input-format/);
    assert.match(passedArgs, /stream-json/);
    assert.match(passedArgs, /--mcp-config/);
    assert.match(passedArgs, /httpUrl/);
    assert.match(passedArgs, /127\.0\.0\.1:4321/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("QwenCodeAdapter supports live steer over stdin stream-json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timo-qwen-steer-"));
  const cwd = mkdtempSync(join(tmpdir(), "timo-qwen-steer-cwd-"));
  try {
    const cli = fakeQwen(
      dir,
      [
        "read -r turn1",
        `echo '{"type":"system","subtype":"init","session_id":"qwen-sess-steer"}'`,
        "sleep 0.3",
        `echo '{"type":"result","subtype":"success","session_id":"qwen-sess-steer","is_error":false,"num_turns":1,"result":"turn1"}'`,
        "if read -r turn2; then",
        `  echo '{"type":"assistant","session_id":"qwen-sess-steer","message":{"role":"assistant","content":[{"type":"text","text":"steered ok"}]}}'`,
        `  echo '{"type":"result","subtype":"success","session_id":"qwen-sess-steer","is_error":false,"num_turns":2,"result":"steered ok"}'`,
        "fi",
        "exit 0",
      ].join("\n"),
    );

    const adapter = new QwenCodeAdapter({ command: cli });
    const events: RunStreamEvent[] = [];
    const running = adapter.spawn({ taskId: "t-steer", runId: "r-steer", cwd, prompt: "start" }, (ev) => events.push(ev));
    await new Promise((r) => setTimeout(r, 120));
    const steered = await adapter.steer("r-steer", "focus on tests");
    assert.equal(steered.accepted, true);

    const result = await running;
    assert.equal(result.status, "succeeded");
    assert.equal(result.output, "steered ok");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("QwenCodeAdapter strips business secrets from child env while keeping gateway URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timo-qwen-env-"));
  const cwd = mkdtempSync(join(tmpdir(), "timo-qwen-env-cwd-"));
  const prevGh = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "ghp_secret_must_strip";
  try {
    const cli = fakeQwen(
      dir,
      [
        "read -r turn1",
        `echo '{"type":"result","subtype":"success","session_id":"s-env","is_error":false,"num_turns":1,"result":"GH='"$GH_TOKEN"' GW='"$TIMO_MCP_GATEWAY_URL"'"}'`,
        "exit 0",
      ].join("\n"),
    );
    const adapter = new QwenCodeAdapter({ command: cli });
    const result = await adapter.spawn(
      { taskId: "t-env", runId: "r-env", cwd, prompt: "env", mcpGatewayUrl: "http://127.0.0.1:9191/mcp/t/1/n" },
      () => undefined,
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.output, "GH= GW=http://127.0.0.1:9191/mcp/t/1/n");
  } finally {
    if (prevGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGh;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("QwenCodeAdapter keeps non-zero tool_result out of error events and emits settling status after final prose", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timo-qwen-toolerr-"));
  const cwd = mkdtempSync(join(tmpdir(), "timo-qwen-toolerr-cwd-"));
  try {
    const cli = fakeQwen(
      dir,
      [
        "read -r turn1",
        `echo '{"type":"assistant","session_id":"s-err","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"run_shell_command","input":{"command":"git grep missing"}}]}}'`,
        `echo '{"type":"user","session_id":"s-err","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","is_error":true,"content":"Command exited with code 1"}]}}'`,
        `echo '{"type":"assistant","session_id":"s-err","message":{"role":"assistant","content":[{"type":"text","text":"评审结论：无阻塞问题"}]}}'`,
        `echo '{"type":"result","subtype":"success","session_id":"s-err","is_error":false,"num_turns":2,"result":"评审结论：无阻塞问题","yolo_suppressed":"'"$QWEN_CODE_SUPPRESS_YOLO_WARNING"'"}'`,
        "exit 0",
      ].join("\n"),
    );

    const adapter = new QwenCodeAdapter({ command: cli });
    const events: RunStreamEvent[] = [];
    const result = await adapter.spawn({ taskId: "t-err", runId: "r-err", cwd, prompt: "review" }, (ev) => events.push(ev));

    assert.equal(result.status, "succeeded");
    assert.equal(events.filter((e) => e.type === "error").length, 0, "grep/tool_result is_error must not emit type=error");
    const toolRes = events.find((e) => e.type === "tool_result");
    assert.ok(toolRes);
    assert.deepEqual(toolRes.data, { isError: true });
    assert.ok(events.some((e) => e.type === "status" && e.summary.includes("等待执行器收尾")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
