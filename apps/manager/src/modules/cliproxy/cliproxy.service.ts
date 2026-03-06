import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { ConfigFileService } from "../config-file/index.ts";
import type { InternalService } from "../internal/internal.service.ts";

const log = createChildLogger("cliproxy");

const SETTINGS_PATH = "/.atelier/cliproxy-settings.json";
const SANDBOX_KEYS_PATH = "/.atelier/cliproxy-sandbox-keys.json";
const OPENCODE_PROVIDERS_PATH = "/.atelier/cliproxy-opencode-providers.json";

const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_CACHE_TTL_MS = 10 * 60 * 1000;
const KEY_PREFIX = "atelier-sbx";

const NATIVE_PROVIDERS: Record<string, { baseUrlSuffix: string }> = {
  anthropic: { baseUrlSuffix: "/v1" },
  openai: { baseUrlSuffix: "/v1" },
  google: { baseUrlSuffix: "/v1beta" },
};

const ANTIGRAVITY_OWNER = "antigravity";

interface CLIProxySettings {
  enabled: boolean;
}

interface CLIProxyModel {
  id: string;
  owned_by: string;
}

interface ModelsDevModel {
  id: string;
  name: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  modalities?: { input: string[]; output: string[] };
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: { context: number; output: number };
}

interface ModelsDevProvider {
  models: Record<string, ModelsDevModel>;
}

type ModelsDevData = Record<string, ModelsDevProvider>;

interface OpenCodeModelConfig {
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  modalities?: { input: string[]; output: string[] };
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: { context?: number; output?: number };
}

interface NativeProviderOutput {
  options: { baseURL: string; apiKey?: string };
  whitelist: string[];
  models?: Record<string, OpenCodeModelConfig>;
}

interface FallbackProviderOutput {
  npm: string;
  name: string;
  options: { baseURL: string; apiKey?: string };
  models: Record<string, OpenCodeModelConfig>;
}

type ProvidersOutput = Record<
  string,
  NativeProviderOutput | FallbackProviderOutput
>;

export interface CLIProxyStatus {
  enabled: boolean;
  configured: boolean;
  url: string;
  lastRefresh: string | null;
  modelCount: number;
}

export interface CLIProxyExportConfig {
  provider: Record<string, unknown>;
}

export class CLIProxyService {
  private modelsDevCache: ModelsDevData | null = null;
  private modelsDevCacheTime = 0;
  private lastRefresh: Date | null = null;

  constructor(
    private readonly configFileService: ConfigFileService,
    private readonly internalService: InternalService,
  ) {}

  /**
   * Initialize the manager API key on startup.
   * Registers the configured manager API key in CLIProxy if not already present.
   */
  async initialize(): Promise<void> {
    const apiKey = config.integrations.cliproxy.apiKey;
    const managementKey = config.integrations.cliproxy.managementKey;

    if (!apiKey) {
      log.debug("No manager API key configured, skipping initialization");
      return;
    }

    if (!managementKey) {
      log.warn(
        "CLIProxy management key not configured, cannot register manager API key",
      );
      return;
    }

    // Check if already registered
    const baseUrl = this.getManagementBaseUrl();
    if (!baseUrl) return;

    try {
      const res = await fetch(`${baseUrl}/api-keys`, {
        headers: { Authorization: `Bearer ${managementKey}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        log.error(
          { status: res.status },
          "Failed to fetch API keys for manager initialization",
        );
        return;
      }

      const data = (await res.json()) as { "api-keys"?: string[] };
      const keys = data["api-keys"] ?? [];

      if (keys.includes(apiKey)) {
        log.info("Manager API key already registered in CLIProxy");
        return;
      }

      // Add the manager API key
      const ok = await this.managementAddKey(apiKey, managementKey);
      if (ok) {
        log.info("Registered manager API key in CLIProxy");
      } else {
        log.error("Failed to register manager API key in CLIProxy");
      }
    } catch (err) {
      log.error({ err }, "Failed to initialize manager API key");
    }
  }

  getStatus(): CLIProxyStatus {
    const settings = this.getSettings();
    const providers = this.getGeneratedProvidersConfig();
    const cliproxy = providers?.cliproxy as
      | { models?: Record<string, unknown> }
      | undefined;
    const modelCount = cliproxy?.models
      ? Object.keys(cliproxy.models).length
      : 0;

    return {
      enabled: settings.enabled,
      configured: !!config.integrations.cliproxy.url,
      url: config.integrations.cliproxy.url,
      lastRefresh: this.lastRefresh?.toISOString() ?? null,
      modelCount,
    };
  }

  getSettings(): CLIProxySettings {
    const file = this.configFileService.getByPath(SETTINGS_PATH, "global");
    if (!file) return { enabled: false };

    try {
      return JSON.parse(file.content) as CLIProxySettings;
    } catch {
      return { enabled: false };
    }
  }

  setEnabled(enabled: boolean): CLIProxySettings {
    const settings: CLIProxySettings = { enabled };
    this.configFileService.upsert(
      undefined,
      SETTINGS_PATH,
      JSON.stringify(settings),
      "json",
    );
    log.info({ enabled }, "CLIProxy auto-config toggled");
    return settings;
  }

  async refresh(): Promise<{ modelCount: number }> {
    const settings = this.getSettings();
    if (!settings.enabled) {
      this.removeGeneratedProvider();
      return { modelCount: 0 };
    }

    const cliproxyUrl = config.integrations.cliproxy.url;
    if (!cliproxyUrl) {
      log.warn("CLIProxy URL not configured, skipping refresh");
      return { modelCount: 0 };
    }

    const [cliproxyModels, modelsDevData] = await Promise.all([
      this.fetchCliProxyModels(cliproxyUrl),
      this.fetchModelsDevData(),
    ]);

    if (cliproxyModels.length === 0) {
      log.warn("No models returned from CLIProxy");
      return { modelCount: 0 };
    }

    const modelsDevLookup = this.buildModelsDevLookup(modelsDevData);
    const providerConfigs = this.buildProviderConfigs(
      cliproxyUrl,
      cliproxyModels,
      modelsDevLookup,
    );

    this.configFileService.upsert(
      undefined,
      OPENCODE_PROVIDERS_PATH,
      JSON.stringify(providerConfigs),
      "json",
    );

    this.lastRefresh = new Date();
    const modelCount = Object.keys(
      providerConfigs.cliproxy?.models ?? {},
    ).length;
    log.info({ modelCount }, "CLIProxy OpenCode config refreshed");

    await this.internalService
      .syncConfigsToSandboxes()
      .catch((err) =>
        log.warn({ err }, "Failed to sync configs after CLIProxy refresh"),
      );

    return { modelCount };
  }

  getSandboxApiKey(sandboxId: string): string | null {
    const keys = this.loadSandboxKeys();
    return keys[sandboxId] ?? null;
  }

  async createSandboxKey(sandboxId: string): Promise<string | null> {
    const settings = this.getSettings();
    if (!settings.enabled) return null;

    const managementKey = config.integrations.cliproxy.managementKey;
    if (!managementKey) {
      log.warn("No CLIProxy management key configured, skipping key creation");
      return null;
    }

    const suffix = crypto.randomUUID().slice(0, 8);
    const apiKey = `${KEY_PREFIX}-${sandboxId}-${suffix}`;

    const ok = await this.managementAddKey(apiKey, managementKey);
    if (!ok) return null;

    const keys = this.loadSandboxKeys();
    keys[sandboxId] = apiKey;
    this.saveSandboxKeys(keys);

    log.info({ sandboxId }, "Created per-sandbox CLIProxy API key");
    return apiKey;
  }

  async revokeSandboxKey(sandboxId: string): Promise<void> {
    const keys = this.loadSandboxKeys();
    const apiKey = keys[sandboxId];
    if (!apiKey) return;

    const managementKey = config.integrations.cliproxy.managementKey;
    if (managementKey) {
      await this.managementDeleteKey(apiKey, managementKey);
    }

    delete keys[sandboxId];
    this.saveSandboxKeys(keys);
    log.info({ sandboxId }, "Revoked per-sandbox CLIProxy API key");
  }

  getExportableConfig(): CLIProxyExportConfig | null {
    const providers = this.getGeneratedProvidersConfig();
    if (!providers) return null;

    try {
      const baseDomain = config.domain.baseDomain;
      const isLocal = baseDomain === "localhost";
      const localPort =
        config.integrations.cliproxy.url.match(/:(\d+)/)?.[1] ?? "8317";
      const externalBase = isLocal
        ? `http://localhost:${localPort}`
        : `https://cliproxy.${baseDomain}`;

      const exported: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(providers)) {
        const raw = value as Record<string, unknown>;
        const suffix = NATIVE_PROVIDERS[key]?.baseUrlSuffix ?? "/v1";

        exported[key] = {
          ...raw,
          options: {
            baseURL: `${externalBase}${suffix}`,
            apiKey: "<your-api-key>",
          },
        };
      }

      return { provider: exported };
    } catch {
      return null;
    }
  }

  getGeneratedProviders() {
    return this.configFileService.getByPath(OPENCODE_PROVIDERS_PATH, "global");
  }

  getGeneratedProvidersConfig(): Record<string, unknown> | null {
    const file = this.getGeneratedProviders();
    if (!file) return null;
    try {
      return JSON.parse(file.content) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private removeGeneratedProvider() {
    const file = this.configFileService.getByPath(
      OPENCODE_PROVIDERS_PATH,
      "global",
    );
    if (file) {
      this.configFileService.delete(file.id);
      log.info("Removed CLIProxy generated provider config");
    }
  }

  private async fetchCliProxyModels(baseUrl: string): Promise<CLIProxyModel[]> {
    const url = baseUrl.replace(/\/+$/, "");
    const modelsUrl = url.endsWith("/v1")
      ? `${url}/models`
      : `${url}/v1/models`;

    const headers: Record<string, string> = {};
    const apiKey = config.integrations.cliproxy.apiKey;
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    try {
      const response = await fetch(modelsUrl, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        log.error(
          { status: response.status, url: modelsUrl },
          "CLIProxy /v1/models request failed",
        );
        return [];
      }
      const data = (await response.json()) as {
        data?: CLIProxyModel[];
      };
      return data.data ?? [];
    } catch (err) {
      log.error({ err, url: modelsUrl }, "Failed to fetch CLIProxy models");
      return [];
    }
  }

  private async fetchModelsDevData(): Promise<ModelsDevData> {
    const now = Date.now();
    if (
      this.modelsDevCache &&
      now - this.modelsDevCacheTime < MODELS_DEV_CACHE_TTL_MS
    ) {
      return this.modelsDevCache;
    }

    try {
      const response = await fetch(MODELS_DEV_URL, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        log.error({ status: response.status }, "models.dev API request failed");
        return this.modelsDevCache ?? {};
      }
      const data = (await response.json()) as ModelsDevData;
      this.modelsDevCache = data;
      this.modelsDevCacheTime = now;
      return data;
    } catch (err) {
      log.error({ err }, "Failed to fetch models.dev data");
      return this.modelsDevCache ?? {};
    }
  }

  private buildModelsDevLookup(
    data: ModelsDevData,
  ): Map<string, ModelsDevModel> {
    const lookup = new Map<string, ModelsDevModel>();
    for (const provider of Object.values(data)) {
      for (const model of Object.values(provider.models ?? {})) {
        const id = model.id;
        if (id && !lookup.has(id)) {
          lookup.set(id, model);
        }
      }
    }
    return lookup;
  }

  private resolveBaseUrl(rawUrl: string, suffix: string): string {
    const url = rawUrl.replace(/\/+$/, "");
    return url.endsWith("/v1")
      ? url.replace(/\/v1$/, suffix)
      : `${url}${suffix}`;
  }

  private buildApiKeyOption(): { apiKey: string } | undefined {
    const apiKey = config.integrations.cliproxy.apiKey;
    return apiKey ? { apiKey } : undefined;
  }

  private classifyNativeProvider(cm: CLIProxyModel): string | null {
    if (NATIVE_PROVIDERS[cm.owned_by]) return cm.owned_by;
    if (cm.owned_by === ANTIGRAVITY_OWNER) return "google";
    return null;
  }

  private buildProviderConfigs(
    cliproxyUrl: string,
    cliproxyModels: CLIProxyModel[],
    modelsDevLookup: Map<string, ModelsDevModel>,
  ): ProvidersOutput & { cliproxy: FallbackProviderOutput } {
    const apiKeyOpt = this.buildApiKeyOption();

    const nativeBuckets = new Map<string, CLIProxyModel[]>();
    for (const cm of cliproxyModels) {
      const provider = this.classifyNativeProvider(cm);
      if (!provider) continue;
      const bucket = nativeBuckets.get(provider);
      if (bucket) {
        bucket.push(cm);
      } else {
        nativeBuckets.set(provider, [cm]);
      }
    }

    const providers: ProvidersOutput & {
      cliproxy: FallbackProviderOutput;
    } = {
      cliproxy: {
        npm: "@ai-sdk/openai-compatible",
        name: "CLIProxy",
        options: {
          baseURL: this.resolveBaseUrl(cliproxyUrl, "/v1"),
          ...apiKeyOpt,
        },
        models: this.buildAllModels(cliproxyModels, modelsDevLookup),
      },
    };

    for (const [providerKey, providerCfg] of Object.entries(NATIVE_PROVIDERS)) {
      const models = nativeBuckets.get(providerKey);
      if (!models?.length) continue;

      const overrides = this.buildNativeOverrides(
        models,
        modelsDevLookup,
        providerKey,
      );

      const entry: NativeProviderOutput = {
        options: {
          baseURL: this.resolveBaseUrl(cliproxyUrl, providerCfg.baseUrlSuffix),
          ...apiKeyOpt,
        },
        whitelist: models.map((m) => m.id),
      };

      if (Object.keys(overrides).length > 0) {
        entry.models = overrides;
      }

      providers[providerKey] = entry;
    }

    return providers;
  }

  private buildAllModels(
    cliproxyModels: CLIProxyModel[],
    modelsDevLookup: Map<string, ModelsDevModel>,
  ): Record<string, OpenCodeModelConfig> {
    const models: Record<string, OpenCodeModelConfig> = {};

    for (const cm of cliproxyModels) {
      const enrichment = modelsDevLookup.get(cm.id);

      const modelConfig: OpenCodeModelConfig = {
        name: enrichment?.name ?? cm.id,
      };

      if (enrichment) {
        if (enrichment.attachment !== undefined)
          modelConfig.attachment = enrichment.attachment;
        if (enrichment.reasoning !== undefined)
          modelConfig.reasoning = enrichment.reasoning;
        if (enrichment.tool_call !== undefined)
          modelConfig.tool_call = enrichment.tool_call;
        if (enrichment.temperature !== undefined)
          modelConfig.temperature = enrichment.temperature;
        if (enrichment.modalities)
          modelConfig.modalities = enrichment.modalities;
        if (enrichment.cost) modelConfig.cost = enrichment.cost;
        if (enrichment.limit) modelConfig.limit = { ...enrichment.limit };
      }

      models[cm.id] = modelConfig;
    }

    return models;
  }

  private loadSandboxKeys(): Record<string, string> {
    const file = this.configFileService.getByPath(SANDBOX_KEYS_PATH, "global");
    if (!file) return {};
    try {
      return JSON.parse(file.content) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private saveSandboxKeys(keys: Record<string, string>): void {
    this.configFileService.upsert(
      undefined,
      SANDBOX_KEYS_PATH,
      JSON.stringify(keys),
      "json",
    );
  }

  private async managementAddKey(
    apiKey: string,
    managementKey: string,
  ): Promise<boolean> {
    const baseUrl = this.getManagementBaseUrl();
    if (!baseUrl) return false;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${managementKey}`,
    };

    try {
      // GET current keys, append new one, PUT the full list
      const getRes = await fetch(`${baseUrl}/api-keys`, {
        headers: { Authorization: `Bearer ${managementKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!getRes.ok) {
        log.error(
          { status: getRes.status },
          "Failed to fetch API keys from management API",
        );
        return false;
      }

      const data = (await getRes.json()) as { "api-keys"?: string[] };
      const keys = data["api-keys"] ?? [];
      keys.push(apiKey);

      const putRes = await fetch(`${baseUrl}/api-keys`, {
        method: "PUT",
        headers,
        body: JSON.stringify(keys),
        signal: AbortSignal.timeout(10_000),
      });
      if (!putRes.ok) {
        log.error(
          { status: putRes.status },
          "Failed to add API key via management API",
        );
        return false;
      }
      return true;
    } catch (err) {
      log.error({ err }, "Failed to call CLIProxy management API");
      return false;
    }
  }

  private async managementDeleteKey(
    apiKey: string,
    managementKey: string,
  ): Promise<boolean> {
    const baseUrl = this.getManagementBaseUrl();
    if (!baseUrl) return false;

    try {
      const res = await fetch(
        `${baseUrl}/api-keys?value=${encodeURIComponent(apiKey)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${managementKey}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) {
        log.error(
          { status: res.status },
          "Failed to delete API key via management API",
        );
        return false;
      }
      return true;
    } catch (err) {
      log.error({ err }, "Failed to call CLIProxy management API");
      return false;
    }
  }

  private getManagementBaseUrl(): string | null {
    const cliproxyUrl = config.integrations.cliproxy.url;
    if (!cliproxyUrl) return null;
    const url = cliproxyUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    return `${url}/v0/management`;
  }

  private buildNativeOverrides(
    models: CLIProxyModel[],
    modelsDevLookup: Map<string, ModelsDevModel>,
    providerKey: string,
  ): Record<string, OpenCodeModelConfig> {
    const overrides: Record<string, OpenCodeModelConfig> = {};

    for (const cm of models) {
      const override = this.getModelOverride(cm, modelsDevLookup, providerKey);
      if (override) {
        overrides[cm.id] = override;
      }
    }

    return overrides;
  }

  private getModelOverride(
    cm: CLIProxyModel,
    modelsDevLookup: Map<string, ModelsDevModel>,
    providerKey: string,
  ): OpenCodeModelConfig | null {
    if (
      providerKey === "anthropic" &&
      (cm.id.includes("opus-4-6") || cm.id.includes("sonnet-4-6"))
    ) {
      return { limit: { context: 200_000 } };
    }

    if (providerKey === "google" && cm.owned_by === ANTIGRAVITY_OWNER) {
      const enrichment = modelsDevLookup.get(cm.id);
      const modelConfig: OpenCodeModelConfig = {
        name: enrichment?.name ?? cm.id,
      };

      if (enrichment) {
        if (enrichment.attachment !== undefined)
          modelConfig.attachment = enrichment.attachment;
        if (enrichment.reasoning !== undefined)
          modelConfig.reasoning = enrichment.reasoning;
        if (enrichment.tool_call !== undefined)
          modelConfig.tool_call = enrichment.tool_call;
        if (enrichment.temperature !== undefined)
          modelConfig.temperature = enrichment.temperature;
        if (enrichment.modalities)
          modelConfig.modalities = enrichment.modalities;
        if (enrichment.cost) modelConfig.cost = enrichment.cost;
        if (enrichment.limit) modelConfig.limit = { ...enrichment.limit };
      }

      return modelConfig;
    }

    return null;
  }
}
