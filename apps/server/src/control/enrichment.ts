/**
 * Bounded spec enrichment — the ONLY two mutations control performs on a spec
 * as it crosses the seam (atelier-v2 §3.2):
 *   (a) secret resolution — replace `{"$secret": name}` references with values;
 *   (b) org-policy injection — append operator-mandated entries (an audit
 *       process, a compliance file) from the org's policy spec.
 *
 * No merger, no catalog, no fragment resolution — append/substitute steps,
 * deterministic, tiny. A dev hand-crafting a spec against the raw API still
 * gets the mandated pieces, because this runs server-side on every crossing,
 * before `runtime.create(spec)`.
 */
import { mergeSpecs, resolveHarness } from "@atelier/compose";
import { isSecretRef, type SandboxSpec } from "@atelier/spec";
import { config, dashboardUrl } from "../shared/lib/config.ts";
import {
  buildGitAttributionFiles,
  OWNER_ANNOTATION,
  OWNER_EMAIL_ANNOTATION,
  OWNER_ID_METADATA,
} from "../shared/lib/git-attribution.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

/** Display/routing annotation a composed harness stamps onto the spec. */
const HARNESS_ANNOTATION = "atelier.dev/harness";

import type { OrgPolicyService } from "./modules/org-policy/index.ts";
import type { SecretService } from "./modules/secret/index.ts";

const log = createChildLogger("enrichment");

export interface EnrichmentDeps {
  secrets: SecretService;
  orgPolicy: OrgPolicyService;
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
 * Inject sandbox git attribution (atelier-v2 parity with v1's
 * `collectGitCredentialFiles`): the owner's git identity + GitHub credential
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

/** The full enrichment pipeline applied at every seam crossing. */
export async function enrichSpec(
  spec: SandboxSpec,
  orgId: string | undefined,
  deps: EnrichmentDeps,
  opts: EnrichmentOptions = {},
): Promise<SandboxSpec> {
  const withPolicy = injectOrgPolicy(spec, orgId, deps.orgPolicy);
  const withHarness = injectHarness(
    withPolicy,
    orgId,
    deps.orgPolicy,
    opts.toolboxHarnessId,
  );
  const resolved = await resolveSecrets(withHarness, orgId, deps.secrets);
  // Injected last: the credential file carries a GitHub token (not a `$secret`
  // ref), so it must skip the secret-resolution pass entirely.
  return injectGitAttribution(resolved, opts.owner);
}
