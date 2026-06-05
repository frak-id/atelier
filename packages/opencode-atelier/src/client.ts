import { treaty } from "@elysiajs/eden";
import type { App } from "@frak/atelier-manager";
import type { AtelierPluginConfig } from "./types.ts";

export type AtelierClient = ReturnType<typeof treaty<App>>;

type ClientGetter = () => AtelierClient;

let _client: AtelierClient | null = null;
let _baseUrl: string | null = null;

export function createClientGetter(config: AtelierPluginConfig): ClientGetter {
  return () => {
    if (!_client || _baseUrl !== config.managerUrl) {
      _baseUrl = config.managerUrl;
      _client = treaty<App>(config.managerUrl, {
        headers: () => {
          const key = config.apiKey;
          return key ? { authorization: `Bearer ${key}` } : {};
        },
      });
    }
    return _client;
  };
}

export function unwrap<T>(result: { data: T; error: unknown }): NonNullable<T> {
  if (result.error) {
    throw result.error instanceof Error
      ? result.error
      : new Error(String(result.error));
  }
  return result.data as NonNullable<T>;
}
