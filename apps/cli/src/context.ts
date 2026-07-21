/** Shared per-invocation state handed to every command action: lazy config +
 * Treaty client (so `config init`/`doctor` can run before anything is set up)
 * and the global `--json` flag. */
import { type AtelierApi, createClient } from "./client.ts";
import { type CliConfig, resolveConfig } from "./config.ts";

export interface Ctx {
  /** Resolved config; throws a helpful error if no API key is set. */
  config(): CliConfig;
  /** Memoized Treaty client; throws if not configured. */
  api(): AtelierApi;
  /** Global `--json` flag (set by the root pre-action hook). */
  json: boolean;
}

export function createCtx(): Ctx {
  let cfg: CliConfig | undefined;
  let client: AtelierApi | undefined;
  return {
    json: false,
    config() {
      cfg ??= resolveConfig();
      return cfg;
    },
    api() {
      client ??= createClient(this.config());
      return client;
    },
  };
}
