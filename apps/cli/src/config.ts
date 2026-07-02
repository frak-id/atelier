/**
 * CLI config, entirely env-driven (atelier-v2 §4: the CLI is a thin client
 * over `/v1` + the same auth any API caller uses — `Authorization: Bearer
 * atl_…` minted via `POST /api-keys`).
 */
export interface CliConfig {
  baseUrl: string;
  apiKey: string;
}

export function resolveConfig(): CliConfig {
  const baseUrl = (process.env.ATELIER_API_URL ?? "http://localhost:4000")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = (process.env.ATELIER_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "ATELIER_API_KEY is not set. Mint one with `POST /api-keys` (Bearer " +
        "atl_…) and export ATELIER_API_KEY. Set ATELIER_API_URL to point at " +
        "your server (default http://localhost:4000).",
    );
  }
  return { baseUrl, apiKey };
}
