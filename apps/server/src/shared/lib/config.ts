import { loadConfig, loadProvidedConfig } from "@frak/atelier-shared";

export const config = loadConfig();

/** The operator-provided config (file + env, no schema defaults). Lets the
 * runtime config plane tell an explicitly-set key (lock it read-only) from one
 * left at its default (editable from the console). */
export const providedConfig = loadProvidedConfig();

/** Fully-stubbed dev mode: the agent + kube clients return canned data and no
 * real runtime is touched. Distinct from `local`, which runs the real runtime
 * (Docker backend) and only bypasses auth. */
export const isMock = () => config.server.mode === "mock";

/** Real cluster runtime + GitHub OAuth + secure cookies. */
export const isProduction = () => config.server.mode === "production";

/** Single-user laptop mode (`atelier local up`): real runtime, no OAuth app,
 * cluster-only infra skipped. */
export const isLocal = () => config.server.mode === "local";

/** Auth is bypassed (fixed mock user, any token accepted) in both `mock` and
 * `local` — neither requires a GitHub OAuth app. Runtime behavior still
 * differs: only `mock` stubs the agent/kube clients. */
export const isAuthBypassed = () =>
  config.server.mode === "mock" || config.server.mode === "local";

export const dashboardUrl = config.domain.dashboard.includes("localhost")
  ? `http://${config.domain.dashboard}`
  : `https://${config.domain.dashboard}`;

export function deriveCallbackUrl(path: string) {
  if (config.domain.dashboard.includes("localhost")) {
    return `http://localhost:${config.server.port}${path}`;
  }
  return `https://${config.domain.dashboard}${path}`;
}
