/**
 * Bounded spec enrichment — the ONLY two mutations control performs on a spec
 * as it crosses the seam (atelier-v2 §3.2):
 *   (a) secret resolution — replace `{"$secret": name}` references with values;
 *   (b) org-policy injection — append operator-mandated entries (an audit
 *       process, a compliance file) from the org's policy spec.
 *
 * No merger, no catalog, no fragment resolution — two append/substitute
 * steps, deterministic, tiny. A dev hand-crafting a spec against the raw API
 * still gets the mandated pieces, because this runs server-side on every
 * crossing, before `runtime.create(spec)`.
 */
import { isSecretRef, type SandboxSpec } from "@atelier/spec";
import type { OrgPolicyService } from "./modules/org-policy/index.ts";
import type { SecretService } from "./modules/secret/index.ts";

export interface EnrichmentDeps {
  secrets: SecretService;
  orgPolicy: OrgPolicyService;
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

/** The full enrichment pipeline applied at every seam crossing. */
export async function enrichSpec(
  spec: SandboxSpec,
  orgId: string | undefined,
  deps: EnrichmentDeps,
): Promise<SandboxSpec> {
  const withPolicy = injectOrgPolicy(spec, orgId, deps.orgPolicy);
  return resolveSecrets(withPolicy, orgId, deps.secrets);
}
