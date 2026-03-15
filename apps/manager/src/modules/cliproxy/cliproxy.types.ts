export interface CLIProxySettings {
  enabled: boolean;
}

export interface CLIProxyModel {
  id: string;
  owned_by: string;
}

export interface ModelsDevModel {
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

export interface ModelsDevProvider {
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevData = Record<string, ModelsDevProvider>;

export interface RawUsageModelStats {
  total_requests: number;
  total_tokens: number;
  details?: unknown[];
}

export interface RawUsageApiStats {
  total_requests: number;
  total_tokens: number;
  models?: Record<string, RawUsageModelStats>;
}

export type DeveloperStatsMap = Map<
  string,
  {
    requests: number;
    tokens: number;
    models: Map<string, { requests: number; tokens: number }>;
  }
>;

export interface RawUsageResponse {
  failed_requests: number;
  usage: {
    total_requests: number;
    success_count: number;
    failure_count: number;
    total_tokens: number;
    apis?: Record<string, RawUsageApiStats>;
    requests_by_day?: Record<string, number>;
    tokens_by_day?: Record<string, number>;
    requests_by_hour?: Record<string, number>;
    tokens_by_hour?: Record<string, number>;
  };
}

export interface OpenCodeModelConfig {
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

export interface NativeProviderOutput {
  options: { baseURL: string; apiKey?: string };
  whitelist: string[];
  models?: Record<string, OpenCodeModelConfig>;
}

export interface FallbackProviderOutput {
  npm: string;
  name: string;
  options: { baseURL: string; apiKey?: string };
  models: Record<string, OpenCodeModelConfig>;
}

export type ProvidersOutput = Record<
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

export interface CLIProxyModelUsage {
  model: string;
  requests: number;
  tokens: number;
}

export interface CLIProxySandboxUsage {
  totalRequests: number;
  totalTokens: number;
  models: CLIProxyModelUsage[];
}

export interface CLIProxyDeveloperUsage {
  username: string;
  totalRequests: number;
  totalTokens: number;
  models: CLIProxyModelUsage[];
}

export interface CLIProxyUsage {
  global: {
    totalRequests: number;
    successCount: number;
    failureCount: number;
    totalTokens: number;
    models: CLIProxyModelUsage[];
    today: { requests: number; tokens: number } | null;
  };
  sandboxes: Record<string, CLIProxySandboxUsage>;
  developers: CLIProxyDeveloperUsage[];
}
