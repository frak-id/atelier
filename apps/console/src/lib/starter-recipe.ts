/**
 * How a Launchpad starter's recipe maps to its boot source: a stored
 * prebuild (followed by its spec, or pinned by snapshot ref) or one set up in
 * the starter itself (base image + git repos + setup steps). Pure, so the
 * editor, the prebuild picker and the "new starter from this prebuild" link
 * share one rule, and it's unit-tested directly.
 */
import {
  canonicalJson,
  type PrebuildRecord,
  type PrebuildRepo,
  type PrebuildSpec,
  type RuntimeSurface,
  runtimeSurfaceOf,
  type StarterInput,
} from "@atelier/spec";

type Recipe = StarterInput["recipe"];

/** A new starter before the author touches it. */
export function blankStarterInput(image: string): StarterInput {
  return {
    title: "",
    description: "",
    icon: "sparkles",
    guide: "",
    published: true,
    recipe: {
      source: { image },
      resources: { vcpus: 2, memoryMb: 4096 },
    },
    services: [],
  };
}

/**
 * Boot `recipe` from a stored prebuild. With its spec stored, the recipe
 * carries it and every launch re-resolves it (a cache hit when unchanged),
 * so a rebuilt prebuild reaches new workspaces. A hand-made snapshot has no
 * spec and can only be pinned by ref.
 */
export function withStoredPrebuild(
  recipe: Recipe,
  record: PrebuildRecord,
): Recipe {
  const { prebuild: _drop, ...rest } = recipe;
  return record.spec
    ? { ...rest, source: record.spec.source, prebuild: record.spec }
    : { ...rest, source: { snapshot: record.ref } };
}

/** The stored prebuild `recipe` boots from, if any: by spec (followed) or by
 * pinned snapshot ref. */
export function matchStoredPrebuild(
  recipe: Recipe,
  prebuilds: readonly PrebuildRecord[],
): PrebuildRecord | undefined {
  if (recipe.prebuild) {
    // Canonical: storage round-trips don't keep key order.
    const want = canonicalJson(recipe.prebuild);
    return prebuilds.find((p) => p.spec && canonicalJson(p.spec) === want);
  }
  if ("snapshot" in recipe.source) {
    const ref = recipe.source.snapshot;
    return prebuilds.find((p) => p.ref === ref);
  }
  return undefined;
}

/** Which editor mode fits `recipe`: a pinned snapshot or a spec equal to a
 * stored prebuild's is "stored"; anything else was set up here. */
export function bootMode(
  recipe: Recipe,
  prebuilds: readonly PrebuildRecord[],
): "stored" | "custom" {
  if ("snapshot" in recipe.source) return "stored";
  return matchStoredPrebuild(recipe, prebuilds) ? "stored" : "custom";
}

/**
 * The "set it up here" form: base image, repos, setup steps as the raw
 * textarea text (so a trailing space or an empty line being typed survives
 * a render; it's only cleaned when written into the recipe), and the
 * projects' dev servers (`processes`/`ports`, the toolbox scheme).
 */
export interface CustomBoot {
  image: string;
  repos: PrebuildRepo[];
  steps: string;
  surface: RuntimeSurface;
}

/** The custom form for `recipe` (also: "Customize" a followed prebuild). */
export function customBootOf(recipe: Recipe, defaultImage: string): CustomBoot {
  const source = recipe.prebuild?.source ?? recipe.source;
  return {
    image: "image" in source ? source.image : defaultImage,
    repos: recipe.prebuild?.repos ?? [],
    steps: (recipe.prebuild?.build ?? []).join("\n"),
    surface: runtimeSurfaceOf(recipe.prebuild ?? {}),
  };
}

/**
 * Write the custom form into `recipe`. Nothing to clone or build boots the
 * image directly (no prebuild, and so no dev servers: they run projects);
 * otherwise an inline prebuild bakes on the first launch, and its
 * processes/ports run in every workspace. Blank repo rows and blank steps
 * are dropped, and prebuild fields the form doesn't show (`files`, `env`,
 * set in JSON mode or carried over by "Customize") are kept.
 */
export function withCustomBoot(recipe: Recipe, boot: CustomBoot): Recipe {
  const { prebuild: previous, ...rest } = recipe;
  const source = { image: boot.image };
  const repos = boot.repos.filter((r) => r.url.trim());
  const build = boot.steps
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (repos.length === 0 && build.length === 0) return { ...rest, source };
  const kept: Partial<PrebuildSpec> = {
    ...(previous?.files ? { files: previous.files } : {}),
    ...(previous?.env ? { env: previous.env } : {}),
  };
  return {
    ...rest,
    source,
    prebuild: {
      ...kept,
      source,
      ...(repos.length > 0 ? { repos } : {}),
      ...(build.length > 0 ? { build } : {}),
      ...runtimeSurfaceOf(boot.surface),
    },
  };
}

/** The prebuild recipe `recipe` boots with: its own (followed or set up
 * here), or the stored one it pins. Its processes/ports are what the server
 * adds at launch, like a toolbox's. */
export function recipePrebuildSpec(
  recipe: Recipe,
  prebuilds: readonly PrebuildRecord[],
): PrebuildSpec | undefined {
  if (recipe.prebuild) return recipe.prebuild;
  if (!("snapshot" in recipe.source)) return undefined;
  const ref = recipe.source.snapshot;
  return prebuilds.find((p) => p.ref === ref)?.spec;
}
