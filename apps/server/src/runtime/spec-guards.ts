/**
 * Pure spec rules and projections shared by the lifecycle code: what may
 * cross the seam, how a resume merges, which repos a sandbox booted with.
 */
import {
  isSecretRef,
  type ResumeRequest,
  repoKey,
  type SandboxRepo,
  type SandboxSpec,
} from "@atelier/spec";
import { ValidationError } from "../shared/errors.ts";
import { qualifyImageName } from "../shared/lib/runtime-config.ts";
import type { SnapshotRecord } from "./store.ts";

/** `spec.toolsets` has no schema-level uniqueness guarantee — TypeBox lacks
 * `uniqueItems` (see the doc comment on `SandboxSpecSchema.toolsets`) and
 * dedup otherwise only happens downstream (agent-side overlay assembly),
 * silently. Reject a duplicate `ref` here with a clean 400 instead (design
 * review H8). */
export function rejectDuplicateToolsetRefs(spec: SandboxSpec): void {
  if (!spec.toolsets || spec.toolsets.length < 2) return;
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const t of spec.toolsets) {
    if (seen.has(t.ref)) duplicates.add(t.ref);
    seen.add(t.ref);
  }
  if (duplicates.size > 0) {
    throw new ValidationError(
      `Spec contains duplicate toolset references: ${[...duplicates].join(", ")}.`,
    );
  }
}

export function rejectUnresolvedSecrets(spec: SandboxSpec): void {
  const offenders: string[] = [];
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (isSecretRef(v)) offenders.push(`env.${k}`);
  }
  for (const f of spec.files ?? []) {
    if (isSecretRef(f.content)) offenders.push(`files[${f.path}]`);
  }
  for (const p of spec.processes ?? []) {
    for (const [k, v] of Object.entries(p.env ?? {})) {
      if (isSecretRef(v)) offenders.push(`processes[${p.name}].env.${k}`);
    }
  }
  if (offenders.length > 0) {
    throw new ValidationError(
      `Spec contains unresolved secret references: ${offenders.join(", ")}. ` +
        "Secrets must be resolved by control before crossing the seam.",
    );
  }
}

/** Deepest prebuild chain `sourceRepos` walks: a guard against a corrupt
 * `parent` loop, far past any real chain. */
const MAX_PREBUILD_CHAIN = 16;

/**
 * The repos a sandbox booted with: those cloned by the prebuild snapshot it
 * boots from and by every prebuild that one is chained on, root first,
 * deduped by `repoKey` (the nearest bake's branch wins). Empty for an image
 * source, or a snapshot without a recipe (a pause or manual snapshot).
 */
export function sourceRepos(
  spec: SandboxSpec,
  snapshots: ReadonlyMap<string, SnapshotRecord>,
): SandboxRepo[] {
  if (!("snapshot" in spec.source)) return [];
  const chain: SnapshotRecord[] = [];
  const seen = new Set<string>();
  let ref: string | undefined = spec.source.snapshot;
  while (ref && !seen.has(ref) && chain.length < MAX_PREBUILD_CHAIN) {
    seen.add(ref);
    const snap = snapshots.get(ref);
    if (!snap) break;
    chain.push(snap);
    ref = snap.parent;
  }
  const repos = new Map<string, SandboxRepo>();
  for (const snap of chain.reverse()) {
    for (const repo of snap.spec?.repos ?? []) {
      repos.set(repoKey(repo.url), {
        url: repo.url,
        ...(repo.branch ? { branch: repo.branch } : {}),
      });
    }
  }
  return [...repos.values()];
}

export function mergeResume(
  spec: SandboxSpec,
  req: ResumeRequest,
): SandboxSpec {
  // Files merge keyed by path (incoming wins): resume re-injects rotated
  // credentials every cycle, so an append would grow `spec.files` — which is
  // persisted back onto the record — without bound.
  let files = spec.files;
  if (req.files) {
    const incoming = new Set(req.files.map((f) => f.path));
    files = [
      ...(spec.files ?? []).filter((f) => !incoming.has(f.path)),
      ...req.files,
    ];
  }
  return {
    ...spec,
    files,
    env: req.env ? { ...(spec.env ?? {}), ...req.env } : spec.env,
  };
}

/** Resolve a host-relative toolset ref (`toolsets/<name>@sha256:…`) to a
 * full pullable registry locator by prepending the configured registry. */
export function resolveToolsetRef(ref: string): string {
  return qualifyImageName(ref);
}

/** Resolve a spec's `toolsets[]` to full pull references for materialize,
 * or undefined when the spec declares none. */
export function resolveSpecToolsets(spec: SandboxSpec): string[] | undefined {
  if (!spec.toolsets || spec.toolsets.length === 0) return undefined;
  return spec.toolsets.map((t) => resolveToolsetRef(t.ref));
}

/** The host-relative refs a spec mounts, as the `sandbox_toolset_refs` join
 * stores them (toolset-overlay-squashfs.md §6-7). */
export function toRefEntries(
  toolsetRefs: SandboxSpec["toolsets"],
): Array<{ ref: string }> {
  return (toolsetRefs ?? []).map((t) => ({ ref: t.ref }));
}
