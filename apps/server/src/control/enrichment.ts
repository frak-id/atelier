/**
 * Bounded spec enrichment — the mutations control performs on a spec as it
 * crosses the seam (docs/archive/design.md §3.2), in two steps:
 *   - `enrichSpec`, at create: the harness composition, the owner stamp and
 *     the sandbox domain for dev servers' host checks. Its output is what the
 *     runtime STORES: `$secret` refs stay refs, and no credential is in it.
 *   - `resolveBootSpec`, at EVERY boot (create, resume, fork): replace
 *     `{"$secret": name}` references with values and add the owner's git
 *     files with their current token. Its output only goes to the backend.
 *
 * No merger, no catalog, no fragment resolution — substitute/append steps,
 * deterministic, tiny. The api/ seam merges the spawn's toolboxes (their
 * `files` included) into the spec BEFORE this runs, so a toolbox file's
 * `$secret` refs are resolved at boot like any other.
 */
import {
  isSecretRef,
  SANDBOX_ORG_ANNOTATION,
  type SandboxSpec,
} from "@atelier/spec";
import { findHarness } from "../harnesses/index.ts";
import { mergeSpecs } from "../harnesses/spec-merge.ts";
import { config, dashboardUrl } from "../shared/lib/config.ts";
import {
  buildGitAttributionFiles,
  GIT_CREDENTIALS_PATH,
  GITCONFIG_PATH,
  OWNER_ANNOTATION,
  OWNER_EMAIL_ANNOTATION,
  OWNER_ID_METADATA,
  OWNER_KIND_ANNOTATION,
} from "../shared/lib/git-attribution.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

/** Display/routing annotation a composed harness stamps onto the spec. */
const HARNESS_ANNOTATION = "atelier.dev/harness";

import type { GitCredentialService } from "./git-credentials.ts";
import type { SecretService } from "./modules/secret/index.ts";
import type { UserKind } from "./types.ts";

const log = createChildLogger("enrichment");

/** What `resolveBootSpec` reads: secret values and the owner's git
 * identity and token. */
export interface BootSpecDeps {
  secrets: SecretService;
  credentials: Pick<GitCredentialService, "resolve">;
}

/**
 * The sandbox owner (the git user): the identity displayed on the console and
 * stamped on the stored spec. Resolved by the `api/` seam (control owns
 * `UserService`); the runtime never sees it.
 */
export interface OwnerContext {
  id: string;
  username: string;
  email: string;
  /** `service` stamps the owner-kind annotation; absent means a person. */
  kind?: UserKind;
}

/** Options carrying pre-resolved, per-request enrichment hints. */
export interface EnrichmentOptions {
  /** The harness id resolved from the spawn's toolboxes (see `api/` seam). */
  toolboxHarnessId?: string;
  /** The sandbox owner — stamps the owner annotations and owner-id. */
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

  const harness = findHarness(harnessId);
  if (!harness) {
    log.warn({ harnessId }, "unknown harness; leaving spec unharnessed");
    return spec;
  }
  // Web-UI options are per-harness and ignored when unknown: opencode reads
  // `webUiCorsOrigin` (the console origin, for its `serve` `--cors`); pi reads
  // `webUiAllowedHosts` (the sandbox base domain, for PI WEB's host-check).
  const fragment = harness.compose({
    webUiCorsOrigin: dashboardUrl,
    webUiAllowedHosts: config.domain.baseDomain,
  });
  return mergeSpecs(spec, fragment) as SandboxSpec;
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
 * Stamp the owner on the spec: display annotations and an owner-id metadata
 * tag (so every boot can re-resolve the owner's git files and token). No-op
 * without an owner.
 */
function stampOwner(
  spec: SandboxSpec,
  owner: OwnerContext | undefined,
): SandboxSpec {
  if (!owner) return spec;
  // Server-owned like the owner-id: a caller-supplied owner-kind never
  // survives, a person's sandbox carries none.
  const { [OWNER_KIND_ANNOTATION]: _callerKind, ...callerAnnotations } =
    spec.annotations ?? {};
  return {
    ...spec,
    annotations: {
      ...callerAnnotations,
      [OWNER_ANNOTATION]: owner.username,
      [OWNER_EMAIL_ANNOTATION]: owner.email,
      ...(owner.kind === "service"
        ? { [OWNER_KIND_ANNOTATION]: "service" }
        : {}),
    },
    metadata: {
      ...spec.metadata,
      [OWNER_ID_METADATA]: owner.id,
    },
  };
}

/**
 * Re-attribute a stored (already enriched) spec to a new owner: drop the
 * previous owner's owner annotations and metadata, then stamp `owner`'s.
 * `metadata` is the copy's own metadata (the previous owner-id never carries
 * over). Git files of specs stored before they were added at boot are dropped
 * too. Everything else, `$secret` refs included, is kept as stored.
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
    [OWNER_KIND_ANNOTATION]: _ownerKind,
    ...annotations
  } = spec.annotations ?? {};
  return stampOwner(
    {
      ...spec,
      files: spec.files?.filter((f) => !gitPaths.has(f.path)),
      annotations,
      metadata,
    },
    owner,
  );
}

/** The enrichment applied once, when a spec is created. */
export function enrichSpec(
  spec: SandboxSpec,
  opts: EnrichmentOptions = {},
): SandboxSpec {
  const withHarness = injectHarness(spec, opts.toolboxHarnessId);
  const withHosts = injectDevServerHosts(withHarness, config.domain.baseDomain);
  return stampOwner(withHosts, opts.owner);
}

/**
 * The spec a boot runs with, from the stored one: secrets resolved in the
 * sandbox's org (its org annotation) and the owner's git files rebuilt from
 * their CURRENT token, so a rotated secret or token applies on the next boot.
 * The owner is the owner-id metadata, stable whoever triggers the boot; a
 * sandbox without one gets no git files (never someone else's). Throws when a
 * secret no longer exists.
 */
export async function resolveBootSpec(
  spec: SandboxSpec,
  { secrets, credentials }: BootSpecDeps,
): Promise<SandboxSpec> {
  const resolved = await resolveSecrets(
    spec,
    spec.annotations?.[SANDBOX_ORG_ANNOTATION],
    secrets,
  );
  const ownerId = spec.metadata?.[OWNER_ID_METADATA];
  const credential = ownerId ? await credentials.resolve(ownerId) : undefined;
  const gitFiles = buildGitAttributionFiles({
    identity: credential?.identity,
    githubToken: credential?.token,
  });
  const files = [
    // Stale git files from a spec stored before they were added at boot are
    // dropped even when no fresh one replaces them.
    ...(resolved.files ?? []).filter(
      (f) => f.path !== GITCONFIG_PATH && f.path !== GIT_CREDENTIALS_PATH,
    ),
    ...gitFiles,
  ];
  return files.length > 0 ? { ...resolved, files } : resolved;
}
