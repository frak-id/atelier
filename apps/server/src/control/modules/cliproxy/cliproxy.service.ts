/**
 * CLIProxy provider wiring for the opencode harness.
 *
 * TODO(remove): ARCHITECTURAL SMELL — this hardcodes a deployment-specific
 * integration (CLIProxy) and a harness-specific file shape (opencode.json)
 * into control, and `enrichSpec` runs it on EVERY sandbox spawn. v2's whole
 * point is to stay ultra-generic: provider wiring like this belongs to a
 * specific toolbox (opt-in, composed like any other toolbox config), or to a
 * future plugin surface — not to a baked-in control module. Kill this module
 * and its `enrichSpec` hook once toolbox-level provider injection exists.
 *
 * v1 ran a full CLIProxyService (deploy, per-sandbox key registration,
 * models.dev enrichment, config sync). v2 only needs the essential piece: turn
 * a reachable CLIProxy endpoint into an opencode `provider` block so sessions
 * have models to select. The API key stays server-side (config/secret) and is
 * baked into the sandbox's opencode.json at spec-enrichment time — never sent
 * to the browser.
 *
 * Model list is fetched from `${baseURL}/models` and cached; a fetch failure
 * is a soft no-op (sandbox still boots, just without providers) rather than a
 * boot-blocking error.
 */
import { config } from "../../../shared/lib/config.ts";

const CACHE_TTL_MS = 5 * 60_000;

interface CliproxyModelsResponse {
  data?: Array<{ id?: string }>;
}

export class CliproxyService {
  private cache: { providers: Record<string, unknown>; at: number } | null =
    null;
  private inflight: Promise<Record<string, unknown> | null> | null = null;

  /** opencode `{ provider: {...} }` entry, or null when CLIProxy is not
   * configured / unreachable. Cached for CACHE_TTL_MS; failures aren't cached. */
  async getProviders(): Promise<Record<string, unknown> | null> {
    const { url, apiKey } = config.integrations.cliproxy;
    if (!url || !apiKey) return null;
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.providers;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.build(url, apiKey).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async build(
    url: string,
    apiKey: string,
  ): Promise<Record<string, unknown> | null> {
    const baseURL = resolveBaseUrl(url);
    const modelIds = await this.fetchModelIds(baseURL, apiKey);
    if (!modelIds) return null;
    const providers = {
      cliproxy: {
        npm: "@ai-sdk/openai-compatible",
        name: "CLIProxy",
        options: { baseURL, apiKey },
        models: Object.fromEntries(modelIds.map((id) => [id, { name: id }])),
      },
    };
    this.cache = { providers, at: Date.now() };
    return providers;
  }

  private async fetchModelIds(
    baseURL: string,
    apiKey: string,
  ): Promise<string[] | null> {
    try {
      const res = await fetch(`${baseURL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as CliproxyModelsResponse;
      const ids = (body.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      return ids.length > 0 ? ids : null;
    } catch {
      return null;
    }
  }
}

/** Normalise a configured URL (with or without a trailing `/v1`) to the
 * OpenAI-compatible base (`.../v1`) opencode and `/models` both expect. */
function resolveBaseUrl(rawUrl: string): string {
  const url = rawUrl.replace(/\/+$/, "");
  return url.endsWith("/v1") ? url : `${url}/v1`;
}
