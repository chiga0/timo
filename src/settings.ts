import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { T3RuntimeConfig } from "./config.js";
import { parsePolicy, type LoadedPolicy } from "./auth/policy.js";

/**
 * Optional non-secret T3 settings read from TIMO_HOME/t3.json (0600):
 * `{"url": "...", "projectId": "...", "providerId": "...", "model": "..."}`.
 * The token is never sourced from this file; it arrives through `TIMO_T3_TOKEN`
 * in the service environment, so it cannot leak through a config copy.
 */
export function readT3SettingsFile(home: string): Partial<Omit<T3RuntimeConfig, "token">> {
  const path = join(home, "t3.json");
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const value = parsed[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  const result: Partial<Omit<T3RuntimeConfig, "token">> = {};
  const url = pick("url");
  const projectId = pick("projectId");
  const providerId = pick("providerId");
  const model = pick("model");
  if (url) result.url = url;
  if (projectId) result.projectId = projectId;
  if (providerId) result.providerId = providerId;
  if (model) result.model = model;
  return result;
}

export function resolveT3Config(env: NodeJS.ProcessEnv, home: string): T3RuntimeConfig | null {
  const file = readT3SettingsFile(home);
  const url = env.TIMO_T3_URL?.trim() || file.url;
  const token = env.TIMO_T3_TOKEN?.trim();
  const projectId = env.TIMO_T3_PROJECT_ID?.trim() || file.projectId;
  const providerId = env.TIMO_T3_PROVIDER_ID?.trim() || file.providerId;
  const model = env.TIMO_T3_MODEL?.trim() || file.model;
  if (!url || !token || !projectId || !providerId || !model) return null;
  return { url, token, projectId, providerId, model };
}

/**
 * Loads `TIMO_HOME/policy.json` if present. A file that exists but cannot be
 * parsed is reported as a warning and the safe defaults apply — a broken policy
 * file must never silently widen the delegation.
 */
export function loadPolicyFile(home: string): LoadedPolicy {
  const path = join(home, "policy.json");
  if (!existsSync(path)) return parsePolicy(undefined);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      policy: parsePolicy(undefined).policy,
      source: "default",
      warning: `policy.json rejected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return parsePolicy(raw);
}
