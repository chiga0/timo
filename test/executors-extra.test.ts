import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import type { RunStreamEvent } from "../src/adapters/execution.js";

function fakeCli(dir: string, name: string, script: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return path;
}

test("CodexAdapter streams JSONL items, extracts patch files, mounts MCP gateway URL, and strips secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timo-codex-"));
  const cwd = mkdtempSync(join(tmpdir(), "timo-codex-cwd-"));
  const argsFile = join(dir, "args.txt");
  const prevGh = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "ghp_codex_secret";
  try {
    const cli = fakeCli(
      dir,
      "fake-codex.sh",
      [
        `printf '%s\n' "$@" > "${argsFile}"`,
        `echo '{"type":"thread.started","thread_id":"codex-thr-1"}'`,
        `echo '{"type":"turn.started"}'`,
        `echo '{"type":"item.completed","item":{"id":"i1","type":"file_change","changes":[{"path":"src/a.ts","kind":"update"}]}}'`,
        `echo '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"GH='"$GH_TOKEN"' done"}}'`,
        `echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'`,
        "exit 0",
      ].join("\n"),
    );

    const adapter = new CodexAdapter({ command: cli });
    const events: RunStreamEvent[] = [];
    const res = await adapter.spawn(
      { taskId: "t-cdx", runId: "r-cdx", cwd, prompt: "fix a.ts", mcpGatewayUrl: "http://127.0.0.1:4444/mcp/t/1/n" },
      (ev) => events.push(ev),
    );
    assert.equal(res.status, "succeeded");
    assert.equal(res.externalId, "codex-thr-1");
    assert.equal(res.output, "GH= done");
    assert.ok(events.some((e) => e.type === "patch" && e.summary.includes("src/a.ts")));
    const passed = readFileSync(argsFile, "utf8");
    assert.match(passed, /--json/);
    assert.match(passed, /mcp_servers\.timo\.url/);
  } finally {
    if (prevGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGh;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCodeAdapter streams JSON events, extracts patch files, and strips secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timo-oc-"));
  const cwd = mkdtempSync(join(tmpdir(), "timo-oc-cwd-"));
  const prevEnt = process.env.ENTERPRISE_GIT_TOKEN;
  process.env.ENTERPRISE_GIT_TOKEN = "enterprise_oc_secret";
  try {
    const cli = fakeCli(
      dir,
      "fake-opencode.sh",
      [
        `echo '{"type":"step_start","sessionID":"oc-sess-1"}'`,
        `echo '{"type":"tool_use","sessionID":"oc-sess-1","part":{"type":"tool","tool":"edit","state":{"status":"completed","input":{"filePath":"src/b.ts"},"output":"patched"}}}'`,
        `echo '{"type":"text","sessionID":"oc-sess-1","part":{"type":"text","text":"ENT='"$ENTERPRISE_GIT_TOKEN"' ok"}}'`,
        `echo '{"type":"step_finish","sessionID":"oc-sess-1"}'`,
        "exit 0",
      ].join("\n"),
    );

    const adapter = new OpenCodeAdapter({ command: cli });
    const events: RunStreamEvent[] = [];
    const res = await adapter.spawn({ taskId: "t-oc", runId: "r-oc", cwd, prompt: "fix b.ts" }, (ev) => events.push(ev));
    assert.equal(res.status, "succeeded");
    assert.equal(res.externalId, "oc-sess-1");
    assert.equal(res.output, "ENT= ok");
    assert.ok(events.some((e) => e.type === "patch" && e.summary.includes("src/b.ts")));
    assert.ok(events.some((e) => e.type === "tool_result"));
  } finally {
    if (prevEnt === undefined) delete process.env.ENTERPRISE_GIT_TOKEN;
    else process.env.ENTERPRISE_GIT_TOKEN = prevEnt;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
