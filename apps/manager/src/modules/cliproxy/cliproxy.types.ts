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
