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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** A token substitution the builder must rewrite before running the build.
 *  - `agent`: the in-pod guest agent image (`COPY --from=...`).
 *  - `seed`: another seed's resulting image (`FROM ...`) — `seed` names the
 *    sibling seed (must appear in `dependsOn`).
 */
const SeedSubstitutionSchema = Type.Union([
  Type.Object(
    { token: Type.String(), kind: Type.Literal("agent") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      token: Type.String(),
      kind: Type.Literal("seed"),
      seed: Type.String(),
    },
    { additionalProperties: false },
  ),
]);
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

// Resolve the seeds dir relative to this module's own location, so it works
// regardless of process cwd (dev via `bun --watch`, or a compiled binary run
// from anywhere).
const SEEDS_DIR = dirname(fileURLToPath(import.meta.url));

let cache: SeedManifest[] | undefined;

function readSeed(id: string): SeedManifest {
  const contextDir = join(SEEDS_DIR, id);
  const manifestPath = join(contextDir, "image.json");
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
  return { ...file, id, contextDir };
}

/** Load every embedded seed's manifest (cached after the first call — seeds
 * are baked into the server image and never change at runtime). Throws
 * loudly on a malformed `image.json` rather than silently skipping it. */
export function loadSeeds(): SeedManifest[] {
  if (cache) return cache;
  const ids = readdirSync(SEEDS_DIR).filter((entry) =>
    statSync(join(SEEDS_DIR, entry)).isDirectory(),
  );
  cache = ids.map(readSeed).sort((a, b) => a.id.localeCompare(b.id));
  return cache;
}

/** Look up one seed by its directory-name identity (e.g. "dev-base"). */
export function getSeed(id: string): SeedManifest | undefined {
  return loadSeeds().find((seed) => seed.id === id);
}
