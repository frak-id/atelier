/**
 * Embedded base-image "seeds" — the server ships these Dockerfile+rootfs
 * build contexts (`apps/server/src/runtime/registry/seeds/<name>/`) so a base
 * image is no longer built out-of-band at deploy time (see
 * `infra/k8s/v2/deploy.sh`'s old `build_devbase` step): the console/CLI list
 * them via `GET /v1/images/templates` and trigger an in-cluster build through
 * `ImageBuilderService`, which pushes the result to the operator's own
 * registry. Users may also bring their own Dockerfile or register an
 * external (e.g. GHCR) ref — seeds are just the batteries-included option.
 *
 * A seed's `image.json` is the identity + build-DAG declaration. Two things
 * only the seed author can know, and only a *build* step (not this loader)
 * can resolve:
 *   - `dependsOn`: sibling seeds that must be built (and pushed) first — a
 *     seed's Dockerfile `FROM`s another seed's *resulting* image, not a
 *     public tag.
 *   - `substitutions`: registry-relative tokens baked into the Dockerfile
 *     (`FROM atelier/dev-base:latest`, `COPY --from=zot.../sandbox-agent-v2`)
 *     that must be rewritten to the operator's actual registry + a resolved
 *     digest before the build runs elsewhere. This loader only DECLARES which
 *     tokens exist; `ImageBuilderService` (not yet built — a later worker)
 *     performs the actual rewrite via `ImageRegistryService.resolveImageReference`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** A token substitution the builder must rewrite before running the build:
 * a literal ref baked into the seed's Dockerfile (`FROM …` or
 * `COPY --from=…`) that points at ANOTHER seed's resulting image and must be
 * rewritten to the operator's registry + a resolved digest at build time.
 * `seed` names the sibling seed (which must appear in `dependsOn`). The
 * in-pod agent image is one such sibling seed (`sandbox-agent-v2`), so it
 * needs no special-cased kind. */
const SeedSubstitutionSchema = Type.Object(
  {
    token: Type.String(),
    kind: Type.Literal("seed"),
    seed: Type.String(),
  },
  { additionalProperties: false },
);
export type SeedSubstitution = Static<typeof SeedSubstitutionSchema>;

/** On-disk shape of a seed's `image.json`. */
const SeedManifestFileSchema = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    volumeSize: Type.Number(),
    tools: Type.Array(Type.String()),
    base: Type.Union([Type.String(), Type.Null()]),
    official: Type.Boolean(),
    dependsOn: Type.Array(Type.String(), { default: [] }),
    substitutions: Type.Array(SeedSubstitutionSchema, { default: [] }),
    /** Repo-relative path whose build context this seed borrows when its own
     * directory carries no Dockerfile — the "source stays in apps/, copied in
     * at server-build time" seam (the agent seed: image.json is committed
     * here, the Rust context is COPYed in for the deployed image, and in dev
     * this points back at `apps/agent-v2`). Ignored once a local Dockerfile
     * is present (the copied-in / prod case). */
    contextFrom: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
type SeedManifestFile = Static<typeof SeedManifestFileSchema>;

/** A loaded seed: the file's declared fields plus the resolved absolute
 * `contextDir` (the directory the builder must hand its backend verbatim —
 * Dockerfile + rootfs/ + any other build-context files, untouched). */
export interface SeedManifest extends SeedManifestFile {
  /** The seed's identity — its directory name, e.g. "dev-base". Distinct
   * from `name` (a human display string, e.g. "Base Development"). */
  id: string;
  /** Absolute path to the seed's build context directory. */
  contextDir: string;
}

// Resolve the seeds dir. In the bundled server (`bun build` inlines all TS
// into one `server.js`), `import.meta.url` points at `/app`, NOT a seeds
// subdir, so the deployed image sets ATELIER_SEEDS_DIR to where the Dockerfile
// COPYs the seed contexts. In dev it's unset and we resolve relative to this
// module's own location (works regardless of cwd).
const SEEDS_DIR =
  process.env.ATELIER_SEEDS_DIR ?? dirname(fileURLToPath(import.meta.url));

let cache: SeedManifest[] | undefined;

/** A seed's build context is its own directory when that carries a Dockerfile
 * (a normal seed, or the agent seed after its Rust context was COPYed in for
 * the deployed image). Otherwise fall back to `contextFrom` (dev: the agent
 * seed borrows `apps/agent-v2`), located by walking up from SEEDS_DIR until
 * the referenced path with a Dockerfile is found. */
function resolveContextDir(seedDir: string, contextFrom?: string): string {
  if (existsSync(join(seedDir, "Dockerfile"))) return seedDir;
  if (contextFrom) {
    let dir = SEEDS_DIR;
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, contextFrom);
      if (existsSync(join(candidate, "Dockerfile"))) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return seedDir;
}

/** H6: `rewriteSeedDockerfile` (`image-builder.service.ts`) resolves every
 * `substitutions[].seed` through the SAME `dependsOn`-ordering contract
 * `buildSeed` enforces (parents must already be built) — a substitution
 * naming a seed absent from `dependsOn` would only surface as a build-time
 * failure (or worse, silently resolve against a stale/unrelated image if one
 * happens to share the name). Validate the subset at load so a drifted
 * `image.json` fails loudly at server boot instead. */
function assertSubstitutionsSubsetOfDependsOn(
  manifestPath: string,
  file: SeedManifestFile,
): void {
  const dependsOn = new Set(file.dependsOn);
  for (const sub of file.substitutions) {
    if (!dependsOn.has(sub.seed)) {
      throw new Error(
        `Malformed seed manifest ${manifestPath}: substitution token ` +
          `'${sub.token}' references seed '${sub.seed}', which is not ` +
          `listed in dependsOn (${JSON.stringify(file.dependsOn)}).`,
      );
    }
  }
}

function readSeed(id: string): SeedManifest {
  const seedDir = join(SEEDS_DIR, id);
  const manifestPath = join(seedDir, "image.json");
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  // Apply schema defaults (dependsOn/substitutions may be omitted) BEFORE
  // checking — `Value.Check` does not itself apply `default`s.
  const raw = Value.Default(SeedManifestFileSchema, parsed);
  if (!Value.Check(SeedManifestFileSchema, raw)) {
    const errors = [...Value.Errors(SeedManifestFileSchema, raw)]
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`Malformed seed manifest ${manifestPath}: ${errors}`);
  }
  const file = raw as SeedManifestFile;
  assertSubstitutionsSubsetOfDependsOn(manifestPath, file);
  const contextDir = resolveContextDir(seedDir, file.contextFrom);
  return { ...file, id, contextDir };
}

/** H6: reject a `dependsOn` cycle across the whole seed set — a cycle would
 * make `buildSeed`'s "parents must already be a ready image" check
 * unsatisfiable for every seed in the loop (none can ever build first).
 * Plain DFS with a recursion stack; seed graphs are tiny (a handful of
 * nodes) so this stays O(seeds + edges) with no need for anything fancier. */
function assertNoDependsOnCycle(seeds: SeedManifest[]): void {
  const byId = new Map(seeds.map((s) => [s.id, s]));
  const state = new Map<string, "visiting" | "done">();

  const visit = (id: string, path: string[]): void => {
    const status = state.get(id);
    if (status === "done") return;
    if (status === "visiting") {
      throw new Error(
        `Seed dependsOn cycle detected: ${[...path, id].join(" -> ")}`,
      );
    }
    state.set(id, "visiting");
    const seed = byId.get(id);
    // A dependsOn entry naming a seed that doesn't exist on disk isn't a
    // cycle — leave that failure to buildSeed's own "has not been built yet"
    // guard, which already handles a missing/unbuilt parent at build time.
    if (seed) {
      for (const parent of seed.dependsOn) visit(parent, [...path, id]);
    }
    state.set(id, "done");
  };

  for (const seed of seeds) visit(seed.id, []);
}

/** Load every embedded seed's manifest (cached after the first call — seeds
 * are baked into the server image and never change at runtime). Throws
 * loudly on a malformed `image.json` (including a `substitutions`/
 * `dependsOn` drift or a `dependsOn` cycle, H6) rather than silently
 * skipping it. */
export function loadSeeds(): SeedManifest[] {
  if (cache) return cache;
  const ids = readdirSync(SEEDS_DIR).filter((entry) =>
    statSync(join(SEEDS_DIR, entry)).isDirectory(),
  );
  const seeds = ids.map(readSeed).sort((a, b) => a.id.localeCompare(b.id));
  assertNoDependsOnCycle(seeds);
  cache = seeds;
  return cache;
}

/** Look up one seed by its directory-name identity (e.g. "dev-base"). */
export function getSeed(id: string): SeedManifest | undefined {
  return loadSeeds().find((seed) => seed.id === id);
}
