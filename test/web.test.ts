import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router, newSessionToken, startListener } from "../src/http/server.js";
import { registerWeb } from "../src/http/web.js";

const TOKEN = newSessionToken();

interface Result {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(base: string, path: string, headers: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function bootBundle(): Promise<{ base: string; close: () => Promise<void>; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "timo-webbundle-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Timo</title>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log('timo')");
  const router = new Router();
  registerWeb(router, dir, TOKEN);
  const listener = await startListener({ router, target: { host: "127.0.0.1", port: 0 }, token: TOKEN });
  return {
    dir,
    base: `http://127.0.0.1:${listener.port}`,
    close: async () => {
      await listener.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("the workbench page requires the session token", async () => {
  const app = await bootBundle();
  try {
    assert.equal((await get(app.base, "/")).status, 401);
    assert.equal((await get(app.base, "/", { authorization: "Bearer wrong" })).status, 401);
    const ok = await get(app.base, "/", { authorization: `Bearer ${TOKEN}` });
    assert.equal(ok.status, 200);
    assert.match(String(ok.headers["content-type"]), /text\/html/);
  } finally {
    await app.close();
  }
});

test("the page load mirrors the token into a cookie so later requests stay authenticated", async () => {
  const app = await bootBundle();
  try {
    const page = await get(app.base, "/", { authorization: `Bearer ${TOKEN}` });
    const cookie = String(page.headers["set-cookie"] ?? "");
    assert.match(cookie, /timo_session=/);
    assert.match(cookie, /HttpOnly/);
    // A cookie-only request needs no header.
    const assets = await get(app.base, "/assets/app.js", { cookie: `timo_session=${TOKEN}` });
    assert.equal(assets.status, 200);
    assert.match(String(assets.headers["content-type"]), /javascript/);
    // Hashed assets are cacheable, the HTML is not.
    assert.match(String(page.headers["cache-control"]), /no-store/);
    assert.match(String(assets.headers["cache-control"]), /immutable/);
  } finally {
    await app.close();
  }
});

test("an unknown client route falls back to index.html", async () => {
  const app = await bootBundle();
  try {
    const res = await get(app.base, "/tasks/abc", { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 200);
    assert.match(res.body, /<title>Timo<\/title>/);
  } finally {
    await app.close();
  }
});

test("path traversal cannot escape the bundle directory", async () => {
  const app = await bootBundle();
  try {
    const res = await get(app.base, "/..%2f..%2fetc%2fpasswd", { authorization: `Bearer ${TOKEN}` });
    // Falls back to index.html rather than serving an outside file.
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.body, /root:/);
  } finally {
    await app.close();
  }
});

test("a missing bundle reports 503 with an actionable message", async () => {
  const router = new Router();
  registerWeb(router, null, TOKEN);
  const listener = await startListener({ router, target: { host: "127.0.0.1", port: 0 }, token: TOKEN });
  try {
    const res = await get(`http://127.0.0.1:${listener.port}`, "/", { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 503);
    assert.match(res.body, /npm run build:web/);
  } finally {
    await listener.close();
  }
});

test("SSE accepts the token as a query parameter because EventSource cannot set headers", async () => {
  const router = new Router();
  router.add("GET", "/api/events", (context) => ({
    stream: async (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`id: 1\ndata: {"seq":1}\n\n`);
    },
  }));
  const listener = await startListener({ router, target: { host: "127.0.0.1", port: 0 }, token: TOKEN });
  const base = `http://127.0.0.1:${listener.port}`;
  try {
    assert.equal((await get(base, "/api/events?afterSeq=0")).status, 401);
    const viaQuery = await get(base, `/api/events?afterSeq=0&token=${encodeURIComponent(TOKEN)}`);
    assert.equal(viaQuery.status, 200);
    assert.match(viaQuery.body, /"seq":1/);
    const viaCookie = await get(base, "/api/events?afterSeq=0", { cookie: `timo_session=${TOKEN}` });
    assert.equal(viaCookie.status, 200);
  } finally {
    await listener.close();
  }
});
