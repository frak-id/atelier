/**
 * Bounded spec enrichment — the ONLY two mutations control performs on a spec
 * as it crosses the seam (atelier-v2 §3.2):
 *   (a) secret resolution — replace `{"$secret": name}` references with values;
 *   (b) org-policy injection — append operator-mandated entries (an audit
 *       process, a compliance file) from the org's policy spec;
 *   (c) cliproxy provider injection — bake the server-held CLIProxy model
 *       provider into the opencode harness config so sessions have models.
 *
 * No merger, no catalog, no fragment resolution — append/substitute steps,
 * deterministic, tiny. A dev hand-crafting a spec against the raw API still
 * gets the mandated pieces, because this runs server-side on every crossing,
 * before `runtime.create(spec)`.
 */
import {
  mergeSpecs,
  OPENCODE_PATHS,
  opencodeMergeProxyProviders,
  resolveHarness,
} from "@atelier/compose";
import { isSecretRef, type SandboxSpec } from "@atelier/spec";
import { dashboardUrl } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

/** Display/routing annotation a composed harness stamps onto the spec. */
const HARNESS_ANNOTATION = "atelier.dev/harness";

import type { CliproxyService } from "./modules/cliproxy/index.ts";
import type { OrgPolicyService } from "./modules/org-policy/index.ts";
import type { SecretService } from "./modules/secret/index.ts";

const log = createChildLogger("enrichment");

export interface EnrichmentDeps {
  secrets: SecretService;
  orgPolicy: OrgPolicyService;
  cliproxy: CliproxyService;
}

/** Options carrying pre-resolved, per-request enrichment hints. */
export interface EnrichmentOptions {
  /** The harness id resolved from the spawn's toolboxes (see `api/` seam). */
  toolboxHarnessId?: string;
}

/**
 * Compose the winning harness into the spec when it doesn't already declare
 * one. Precedence: the spec's own harness (a `atelier.dev/harness` annotation,
 * composed client-side) > a toolbox-declared harness > the org policy's
 * `harness`. Composition only happens for the two lower tiers; a spec that
 * already carries a harness is returned untouched (it wins).
 */
function injectHarness(
  spec: SandboxSpec,
  orgId: string | undefined,
  orgPolicy: OrgPolicyService,
  toolboxHarnessId: string | undefined,
): SandboxSpec {
  if (spec.annotations?.[HARNESS_ANNOTATION]) return spec;

  const orgFragment = orgId
    ? (orgPolicy.getByOrgId(orgId)?.fragment as
        | { harness?: unknown }
        | undefined)
    : undefined;
  const orgHarness =
    typeof orgFragment?.harness === "string" ? orgFragment.harness : undefined;

  const harnessId = toolboxHarnessId ?? orgHarness;
  if (!harnessId) return spec;

  try {
    // `webUiCorsOrigin`: only the opencode composer reads this key; other
    // harnesses ignore it (`compose()` options are per-harness, unvalidated
    // by this seam — see `resolveHarness`).
    const fragment = resolveHarness(harnessId).compose({
      webUiCorsOrigin: dashboardUrl,
    });
    return mergeSpecs(spec, fragment) as SandboxSpec;
  } catch (err) {
    log.warn({ harnessId, err }, "unknown harness; leaving spec unharnessed");
    return spec;
  }
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

/** Append the org's mandated fragment (never overrides the caller's fields). */
function injectOrgPolicy(
  spec: SandboxSpec,
  orgId: string | undefined,
  orgPolicy: OrgPolicyService,
): SandboxSpec {
  if (!orgId) return spec;
  const policy = orgPolicy.getByOrgId(orgId);
  if (!policy) return spec;
  const fragment = policy.fragment as Partial<SandboxSpec>;

  return {
    ...spec,
    files: [...(spec.files ?? []), ...(fragment.files ?? [])],
    processes: [...(spec.processes ?? []), ...(fragment.processes ?? [])],
    ports: [...(spec.ports ?? []), ...(fragment.ports ?? [])],
    hooks: {
      postCreate: [
        ...(spec.hooks?.postCreate ?? []),
        ...(fragment.hooks?.postCreate ?? []),
      ],
      postStart: [
        ...(spec.hooks?.postStart ?? []),
        ...(fragment.hooks?.postStart ?? []),
      ],
      onResume: [
        ...(spec.hooks?.onResume ?? []),
        ...(fragment.hooks?.onResume ?? []),
      ],
      envChanged: [
        ...(spec.hooks?.envChanged ?? []),
        ...(fragment.hooks?.envChanged ?? []),
      ],
    },
  };
}

/** Merge the CLIProxy provider block into the opencode harness config file
 * (`opencode.json`). No-op when CLIProxy is unconfigured or the spec has no
 * opencode config file (non-opencode harness). The provider carries the
 * server's API key, so it must be injected here, not client-side. */
async function injectCliproxyProviders(
  spec: SandboxSpec,
  cliproxy: CliproxyService,
): Promise<SandboxSpec> {
  const files = spec.files ?? [];
  const existing = files.find((f) => f.path === OPENCODE_PATHS.configPath);
  if (!existing) return spec;

  const providers = await cliproxy.getProviders();
  if (!providers) return spec;

  const content =
    typeof existing.content === "string" ? existing.content : undefined;
  const merged = opencodeMergeProxyProviders(providers, content);
  return {
    ...spec,
    files: files.map((f) => (f === existing ? { ...f, content: merged } : f)),
  };
}

/** The full enrichment pipeline applied at every seam crossing. */
export async function enrichSpec(
  spec: SandboxSpec,
  orgId: string | undefined,
  deps: EnrichmentDeps,
  opts: EnrichmentOptions = {},
): Promise<SandboxSpec> {
  const withPolicy = injectOrgPolicy(spec, orgId, deps.orgPolicy);
  // Harness must be composed before cliproxy provider injection so a
  // toolbox/org-composed `opencode.json` still receives the server's models.
  const withHarness = injectHarness(
    withPolicy,
    orgId,
    deps.orgPolicy,
    opts.toolboxHarnessId,
  );
  const withProviders = await injectCliproxyProviders(
    withHarness,
    deps.cliproxy,
  );
  return resolveSecrets(withProviders, orgId, deps.secrets);
}
