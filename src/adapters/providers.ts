import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DiscoveredModel {
  /** Exact model identifier forwarded to the CLI (`--model` / `-m`). */
  id: string;
  /** Human-readable display label. */
  label: string;
}

export interface DiscoveredProvider {
  id: string;
  name: string;
  models: DiscoveredModel[];
}

export interface ExecutorProviderCatalog {
  executorId: string;
  defaultProvider?: string;
  defaultModel?: string;
  providers: DiscoveredProvider[];
}

export interface DiscoverProvidersOptions {
  homeDir?: string;
  /** Injectable command runner for tests; returns stdout or null if unavailable. */
  runCli?: (cmd: string, args: string[], timeoutMs: number) => string | null;
}

function defaultRunCli(cmd: string, args: string[], timeoutMs: number): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function readJsonSafe(filePath: string): unknown {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function addModel(map: Map<string, Map<string, DiscoveredModel>>, providerId: string, model: DiscoveredModel): void {
  const pid = providerId.trim() || "default";
  let models = map.get(pid);
  if (!models) {
    models = new Map();
    map.set(pid, models);
  }
  if (!models.has(model.id)) {
    models.set(model.id, model);
  }
}

function toProviderList(map: Map<string, Map<string, DiscoveredModel>>): DiscoveredProvider[] {
  return [...map.entries()].map(([id, models]) => ({
    id,
    name: id,
    models: [...models.values()],
  }));
}

/**
 * Discovers non-secret provider and model catalogs from each resident CLI's
 * local config / list command. NEVER reads or returns API keys, tokens, or
 * auth files.
 */
export function discoverExecutorProviders(options: DiscoverProvidersOptions = {}): Record<string, ExecutorProviderCatalog> {
  const home = options.homeDir ?? homedir();
  const runCli = options.runCli ?? defaultRunCli;
  return {
    pi: discoverPi(home, runCli),
    "qwen-code": discoverQwenCode(home),
    codex: discoverCodex(home),
    opencode: discoverOpenCode(home, runCli),
  };
}

function discoverPi(home: string, runCli: NonNullable<DiscoverProvidersOptions["runCli"]>): ExecutorProviderCatalog {
  const settings = asRecord(readJsonSafe(join(home, ".pi/agent/settings.json")));
  const defaultProvider = typeof settings.defaultProvider === "string" ? settings.defaultProvider.trim() : undefined;
  const defaultModel = typeof settings.defaultModel === "string" ? settings.defaultModel.trim() : undefined;

  const grouped = new Map<string, Map<string, DiscoveredModel>>();
  const stdout = runCli("pi", ["--list-models"], 4_000);
  if (stdout) {
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.toLowerCase().startsWith("provider ")) continue;
      const cols = line.split(/\s+/);
      const provider = cols[0];
      const model = cols[1];
      if (!provider || !model) continue;
      addModel(grouped, provider, { id: `${provider}/${model}`, label: model });
    }
  }

  // Fallback to ~/.pi/agent/models.json if CLI output was unavailable.
  if (grouped.size === 0) {
    const modelsJson = asRecord(readJsonSafe(join(home, ".pi/agent/models.json")));
    const providersObj = asRecord(modelsJson.providers);
    for (const [providerId, providerVal] of Object.entries(providersObj)) {
      const models = asRecord(providerVal).models;
      if (!Array.isArray(models)) continue;
      for (const item of models) {
        const rec = asRecord(item);
        const id = typeof rec.id === "string" ? rec.id.trim() : "";
        if (!id) continue;
        const label = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
        addModel(grouped, providerId, { id: `${providerId}/${id}`, label });
      }
    }
  }

  return {
    executorId: "pi",
    ...(defaultProvider ? { defaultProvider } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    providers: toProviderList(grouped),
  };
}

function discoverQwenCode(home: string): ExecutorProviderCatalog {
  const settings = asRecord(readJsonSafe(join(home, ".qwen/settings.json")));
  const modelObj = asRecord(settings.model);
  const defaultModel = typeof modelObj.name === "string" ? modelObj.name.trim() : undefined;
  const grouped = new Map<string, Map<string, DiscoveredModel>>();

  const providersObj = asRecord(settings.modelProviders);
  for (const [providerId, list] of Object.entries(providersObj)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const rec = asRecord(item);
      const id = typeof rec.id === "string" ? rec.id.trim() : "";
      if (!id) continue;
      const label = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
      addModel(grouped, providerId, { id, label });
    }
  }

  // Also read cached non-secret model-registry.json entries if present.
  const registry = asRecord(readJsonSafe(join(home, ".qwen/model-registry.json")));
  const regModels = Array.isArray(registry.models) ? registry.models : [];
  for (const item of regModels) {
    const rec = asRecord(item);
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) continue;
    const providerId =
      (typeof rec.provider === "string" && rec.provider.trim()) ||
      (typeof rec.authType === "string" && rec.authType.trim()) ||
      "registry";
    const label = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
    addModel(grouped, providerId, { id, label });
  }

  if (defaultModel && grouped.size === 0) {
    addModel(grouped, "default", { id: defaultModel, label: defaultModel });
  }

  const defaultProvider = grouped.size > 0 ? [...grouped.keys()][0] : undefined;
  return {
    executorId: "qwen-code",
    ...(defaultProvider ? { defaultProvider } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    providers: toProviderList(grouped),
  };
}

function discoverCodex(home: string): ExecutorProviderCatalog {
  const grouped = new Map<string, Map<string, DiscoveredModel>>();
  let defaultModel: string | undefined;
  let defaultProvider: string | undefined;
  const declaredProviders: string[] = [];

  const tomlPath = join(home, ".codex/config.toml");
  if (existsSync(tomlPath)) {
    try {
      const toml = readFileSync(tomlPath, "utf8");
      defaultModel = toml.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1]?.trim();
      defaultProvider = toml.match(/^\s*model_provider\s*=\s*"([^"]+)"/m)?.[1]?.trim();
      for (const match of toml.matchAll(/^\s*\[model_providers\.([^\]]+)\]/gm)) {
        const name = match[1]?.trim();
        if (name) declaredProviders.push(name);
      }
    } catch {
      // ignore unreadable toml
    }
  }

  const primaryProvider = defaultProvider || "openai";
  const cache = asRecord(readJsonSafe(join(home, ".codex/models_cache.json")));
  const cachedModels = Array.isArray(cache.models) ? cache.models : [];
  for (const item of cachedModels) {
    const rec = asRecord(item);
    if (rec.visibility === "hide") continue;
    const slug = typeof rec.slug === "string" ? rec.slug.trim() : "";
    if (!slug) continue;
    const label = typeof rec.display_name === "string" && rec.display_name.trim() ? rec.display_name.trim() : slug;
    addModel(grouped, primaryProvider, { id: slug, label });
  }

  for (const prov of declaredProviders) {
    if (!grouped.has(prov)) {
      grouped.set(prov, new Map());
    }
  }

  if (defaultModel && grouped.size === 0) {
    addModel(grouped, primaryProvider, { id: defaultModel, label: defaultModel });
  }

  return {
    executorId: "codex",
    defaultProvider: primaryProvider,
    ...(defaultModel ? { defaultModel } : {}),
    providers: toProviderList(grouped),
  };
}

function discoverOpenCode(home: string, runCli: NonNullable<DiscoverProvidersOptions["runCli"]>): ExecutorProviderCatalog {
  const ocConfig = asRecord(readJsonSafe(join(home, ".config/opencode/opencode.json")));
  const configuredModel = typeof ocConfig.model === "string" ? ocConfig.model.trim() : undefined;
  let defaultProvider: string | undefined;
  let defaultModel: string | undefined;
  if (configuredModel) {
    const slash = configuredModel.indexOf("/");
    if (slash > 0) {
      defaultProvider = configuredModel.slice(0, slash);
      defaultModel = configuredModel.slice(slash + 1);
    } else {
      defaultModel = configuredModel;
    }
  }

  const grouped = new Map<string, Map<string, DiscoveredModel>>();
  const stdout = runCli("opencode", ["models"], 4_000);
  if (stdout) {
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.includes(" ")) continue;
      const slash = line.indexOf("/");
      if (slash <= 0 || slash === line.length - 1) continue;
      const provider = line.slice(0, slash);
      const model = line.slice(slash + 1);
      addModel(grouped, provider, { id: line, label: model });
    }
  }

  const providerObj = asRecord(ocConfig.provider);
  for (const [provId, provVal] of Object.entries(providerObj)) {
    const modelsObj = asRecord(asRecord(provVal).models);
    if (Object.keys(modelsObj).length === 0 && !grouped.has(provId)) {
      grouped.set(provId, new Map());
    }
    for (const [modelId, modelVal] of Object.entries(modelsObj)) {
      const name = typeof asRecord(modelVal).name === "string" ? String(asRecord(modelVal).name) : modelId;
      addModel(grouped, provId, { id: `${provId}/${modelId}`, label: name });
    }
  }

  return {
    executorId: "opencode",
    ...(defaultProvider ? { defaultProvider } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    providers: toProviderList(grouped),
  };
}
