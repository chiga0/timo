import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TIMO_HOME is a private directory: 0700 for the directory, 0600 for files it
 * creates. The default is `~/.timo`.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TIMO_HOME?.trim();
  if (configured) return configured;
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) throw new Error("TIMO_HOME is not set and HOME is unavailable");
  return join(home, ".timo");
}

export function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    chmodSync(home, 0o700);
  } catch {
    // Platforms without POSIX modes: best effort only.
  }
}

export function ensureSubdir(home: string, name: string): string {
  ensureHome(home);
  const path = name === "" ? home : join(home, name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/**
 * Writes exact bytes. Text callers pass a string, which is encoded as UTF-8 once
 * here; binary callers pass a `Uint8Array` that is written verbatim so no
 * string transcoding can corrupt multi-byte sequences.
 */
export function writePrivateFile(path: string, content: string | Uint8Array): void {
  writeFileSync(path, content, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore on platforms without POSIX modes
  }
}

export function readPrivateFile(path: string): Uint8Array | null {
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
}
