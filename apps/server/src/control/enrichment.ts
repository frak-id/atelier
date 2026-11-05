/**
 * Bounded spec enrichment — the mutations control performs on a spec as it
 * crosses the seam (design.md §3.2):
 *   (a) secret resolution — replace `{"$secret": name}` references with values;
 *   plus the harness composition, the owner's git attribution, and the
 *   sandbox domain for dev servers' host checks (`injectDevServerHosts`).
 *
 * No merger, no catalog, no fragment resolution — substitute/append steps,
 * deterministic, tiny. The api/ seam merges the spawn's toolboxes (their
 * `files` included) into the spec BEFORE this runs, so a toolbox file's
 * `$secret` refs are resolved here like any other.
 */
import { mergeSpecs, resolveHarness } from "@atelier/compose";
import { isSecretRef, type SandboxSpec } from "@atelier/spec";
import { config, dashboardUrl } from "../shared/lib/config.ts";
import {
  buildGitAttributionFiles,
  GIT_CREDENTIALS_PATH,
  GITCONFIG_PATH,
  OWNER_ANNOTATION,
  OWNER_EMAIL_ANNOTATION,
  OWNER_ID_METADATA,
} from "../shared/lib/git-attribution.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

/** Display/routing annotation a composed harness stamps onto the spec. */
const HARNESS_ANNOTATION = "atelier.dev/harness";

import type { SecretService } from "./modules/secret/index.ts";

const log = createChildLogger("enrichment");

export interface EnrichmentDeps {
  secrets: SecretService;
}

/**
 * The resolved sandbox owner (the git user). Carries the identity displayed on
 * the console and the GitHub token injected as a credential. Resolved by the
 * `api/` seam (control owns `UserService`); the runtime never sees it.
 */
export interface OwnerContext {
  id: string;
  username: string;
  email: string;
  githubToken?: string;
}

/** Options carrying pre-resolved, per-request enrichment hints. */
export interface EnrichmentOptions {
  /** The harness id resolved from the spawn's toolboxes (see `api/` seam). */
  toolboxHarnessId?: string;
  /** The sandbox owner — injects git identity/credentials + owner display. */
  owner?: OwnerContext;
}

/**
 * Compose the toolbox-declared harness into the spec when it doesn't already
 * declare one: a spec that carries its own harness (a `atelier.dev/harness`
 * annotation, composed client-side) is returned untouched (it wins).
 */
function injectHarness(
  spec: SandboxSpec,
  harnessId: string | undefined,
): SandboxSpec {
  if (spec.annotations?.[HARNESS_ANNOTATION] || !harnessId) return spec;

  try {
    // Web-UI options are per-harness and ignored when unknown (`compose()`
    // options aren't validated by this seam — see `resolveHarness`):
    // opencode reads `webUiCorsOrigin` (the console origin, for its `serve`
    // `--cors`); pi reads `webUiAllowedHosts` (the sandbox base domain, for
    // PI WEB's host-check).
    const fragment = resolveHarness(harnessId).compose({
      webUiCorsOrigin: dashboardUrl,
      webUiAllowedHosts: config.domain.baseDomain,
    });
    return mergeSpecs(spec, fragment) as SandboxSpec;
  } catch (err) {
    log.warn({ harnessId, err }, "unknown harness; leaving spec unharnessed");
    return spec;
  }
}

/** Vite's documented env hook for extra `server.allowedHosts` entries. */
export const VITE_ALLOWED_HOSTS_ENV = "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS";

/**
 * Let dev servers answer on the sandbox URLs without touching the repos.
 * Vite's DNS-rebinding guard rejects any `Host` it doesn't know (only
 * `localhost`, `*.localhost` and IPs pass), and a sandbox port is served at
 * `{name}-{sandboxId}.{baseDomain}`. One `.{baseDomain}` entry allows the
 * domain and every subdomain (Vite ≥ 6.1: Astro, Nuxt, SvelteKit, React
 * Router…). Safe here: the only way in is the ingress, behind forward auth.
 *
 * Sandbox-wide `env`, so it reaches supervised processes, hooks and terminal
 * shells alike. Skipped on a `localhost` domain (already allowed); the spec's
 * own value wins.
 */
export function injectDevServerHosts(
  spec: SandboxSpec,
  baseDomain: string,
): SandboxSpec {
  const domain = baseDomain
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^\.+|\.+$/g, "");
  if (!domain || domain === "localhost" || domain.endsWith(".localhost")) {
    return spec;
  }
  if (spec.env?.[VITE_ALLOWED_HOSTS_ENV] !== undefined) return spec;
  return {
    ...spec,
    env: { ...spec.env, [VITE_ALLOWED_HOSTS_ENV]: `.${domain}` },
  };
}

/** Replace every `{"$secret": name}` reference in the spec with its value. */
async function resolveSecrets(
  spec: SandboxSpec,
  orgId: string | undefined,
  secrets: SecretService,
): Promise<SandboxSpec> {
  const resolveValue = async (value: unknown): Promise<string> => {
    if (isSecretRef(value)) return secrets.resolve(orgId, value.$secret);
    return value as string;
  };

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    env[k] = await resolveValue(v);
  }

  const files = await Promise.all(
    (spec.files ?? []).map(async (f) => ({
      ...f,
      content: await resolveValue(f.content),
    })),
  );

  const processes = await Promise.all(
    (spec.processes ?? []).map(async (p) => {
      if (!p.env) return p;
      const resolvedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.env)) {
        resolvedEnv[k] = await resolveValue(v);
      }
      return { ...p, env: resolvedEnv };
    }),
  );

  return {
    ...spec,
    env: Object.keys(env).length > 0 ? env : spec.env,
    files: spec.files ? files : spec.files,
    processes: spec.processes ? processes : spec.processes,
  };
}

/**
 * Inject sandbox git attribution: the owner's git identity + GitHub credential
 * as guest files, plus owner display annotations and an owner-id metadata tag
 * (so resume can re-resolve the token). No-op without an owner.
 */
function injectGitAttribution(
  spec: SandboxSpec,
  owner: OwnerContext | undefined,
): SandboxSpec {
  if (!owner) return spec;
  const gitFiles = buildGitAttributionFiles({
    identity: { name: owner.username, email: owner.email },
    githubToken: owner.githubToken,
  });
  return {
    ...spec,
    files: [...(spec.files ?? []), ...gitFiles],
    annotations: {
      ...spec.annotations,
      [OWNER_ANNOTATION]: owner.username,
      [OWNER_EMAIL_ANNOTATION]: owner.email,
    },
    metadata: {
      ...spec.metadata,
      [OWNER_ID_METADATA]: owner.id,
    },
  };
}

/**
 * Re-attribute a stored (already enriched) spec to a new owner: drop the
 * previous owner's git identity/credential files, owner annotations and
 * metadata, then inject `owner`'s. `metadata` is the copy's own metadata
 * (the previous owner-id never carries over). Everything else, incl. secret
 * values resolved at the source's creation, is kept as stored.
 */
export function reattributeSpec(
  spec: SandboxSpec,
  owner: OwnerContext,
  metadata: Record<string, string> = {},
): SandboxSpec {
  const gitPaths = new Set([GITCONFIG_PATH, GIT_CREDENTIALS_PATH]);
  const {
    [OWNER_ANNOTATION]: _owner,
    [OWNER_EMAIL_ANNOTATION]: _ownerEmail,
    ...annotations
  } = spec.annotations ?? {};
  return injectGitAttribution(
    {
      ...spec,
      files: spec.files?.filter((f) => !gitPaths.has(f.path)),
      annotations,
      metadata,
    },
    owner,
  );
}

/** The full enrichment pipeline applied at every seam crossing. */
export async function enrichSpec(
  spec: SandboxSpec,
  orgId: string | undefined,
  deps: EnrichmentDeps,
  opts: EnrichmentOptions = {},
): Promise<SandboxSpec> {
  const withHarness = injectHarness(spec, opts.toolboxHarnessId);
  const withHosts = injectDevServerHosts(withHarness, config.domain.baseDomain);
  const resolved = await resolveSecrets(withHosts, orgId, deps.secrets);
  // Injected last: the credential file carries a GitHub token (not a `$secret`
  // ref), so it must skip the secret-resolution pass entirely.
  return injectGitAttribution(resolved, opts.owner);
}
