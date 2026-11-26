import type { ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { RouteHandler, Router } from "./server.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

/**
 * Resolves the built workbench bundle: `dist/web` next to the compiled sources,
 * or `TIMO_HOME/web` if an operator dropped a build there. Returns null when the
 * bundle is missing, so `timo serve` still works headless.
 */
export function resolveWebDir(home: string): string | null {
  const candidates = [join(import.meta.dirname, "..", "..", "web"), join(home, "web")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

/**
 * Serves the static bundle and falls back to `index.html` for client routes.
 * The session token from `?token=` is mirrored into a `timo_session` cookie on
 * the first page load, so later navigations and EventSource reconnects work.
 */
export function registerWeb(router: Router, webDir: string | null, token: string): void {
  const serveFile: RouteHandler = (context) => {
    if (!webDir) {
      return {
        status: 503,
        body: { error: { code: "web_bundle_missing", message: "web bundle not built; run `npm run build:web`" } },
      };
    }
    const relative = context.path === "/" ? "index.html" : context.path.slice(1);
    const resolved = safeJoin(webDir, relative);
    const target = resolved && existsSync(resolved) && statSync(resolved).isFile() ? resolved : join(webDir, "index.html");
    const html = extname(target) === ".html";
    return {
      stream: async (res: ServerResponse) => {
        const body = readFileSync(target);
        res.writeHead(200, {
          "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
          "content-length": String(body.length),
          // The page carries the token in its URL, so it must not be cached.
          "cache-control": html ? "no-store" : "public, max-age=31536000, immutable",
          ...(html ? { "set-cookie": `timo_session=${token}; Path=/; SameSite=Strict; HttpOnly` } : {}),
        });
        res.end(body);
      },
    };
  };

  router.add("GET", "/", serveFile);
  router.add("GET", "/index.html", serveFile);
  router.add("GET", "/assets/:file", serveFile);
  // Client-side routes are arbitrarily deep (`/tasks/abc`), so the bundle uses a
  // prefix fallback instead of per-segment patterns.
  router.fallback(serveFile);
}

/** Prevents `..` traversal from escaping the bundle directory. */
function safeJoin(root: string, relative: string): string | null {
  const target = normalize(join(root, relative));
  return target.startsWith(root + sep) || target === join(root, "index.html") ? target : null;
}
