/**
 * How a Launchpad starter's recipe maps to its boot source: a stored
 * prebuild (followed by its recipe, or pinned by snapshot ref) or one set up
 * in the starter itself (base image + git repos + setup steps). Pure, so the
 * editor, the prebuild picker and the "new starter from this prebuild" link
 * share one rule, and it's unit-tested directly.
 *
 * A followed prebuild is carried *without* its dev servers
 * (`withoutSurface`): the server then boots every launch with the stored
 * recipe's current ones, so editing them on the prebuild reaches the
 * starter. Dev servers in `recipe.prebuild` are the starter's own and win
 * over the prebuild's ("set it up here").
 */
import {
  canonicalJson,
  type LaunchpadService,
  type PrebuildRecord,
  type PrebuildRepo,
  type PrebuildSpec,
  prebuildRecipeKey,
  type RuntimeSurface,
  runtimeSurfaceOf,
  type StarterInput,
  withoutSurface,
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
 * carries it minus the dev servers, and every launch re-resolves it (a cache
 * hit when unchanged): a rebuilt prebuild and edited dev servers both reach
 * new workspaces. A hand-made snapshot has no spec and can only be pinned by
 * ref.
 */
export function withStoredPrebuild(
  recipe: Recipe,
  record: PrebuildRecord,
): Recipe {
  const { prebuild: _drop, ...rest } = recipe;
  return record.spec
    ? {
        ...rest,
        source: record.spec.source,
        prebuild: withoutSurface(record.spec),
      }
    : { ...rest, source: { snapshot: record.ref } };
}

/** The stored prebuild whose recipe `recipe` bakes (dev servers aside), or
 * that it pins by snapshot ref. Snapshots of one recipe share their dev
 * servers, and the list is newest-first, so the first match is the one. */
function storedPrebuildOf(
  recipe: Recipe,
  prebuilds: readonly PrebuildRecord[],
): PrebuildRecord | undefined {
  if (recipe.prebuild) {
    const key = prebuildRecipeKey(recipe.prebuild);
    return prebuilds.find((p) => p.spec && prebuildRecipeKey(p.spec) === key);
  }
  if ("snapshot" in recipe.source) {
    const ref = recipe.source.snapshot;
    return prebuilds.find((p) => p.ref === ref);
  }
  return undefined;
}

function hasDevServers(surface: RuntimeSurface): boolean {
  const own = runtimeSurfaceOf(surface);
  return own.processes !== undefined || own.ports !== undefined;
}

/**
 * The stored prebuild `recipe` follows, if any: same recipe and no dev
 * servers of its own (or a copy equal to the prebuild's, as starters saved
 * before they were followed carry: see `followedRecipe`), or pinned by
 * snapshot ref. A recipe with its own, different dev servers was set up
 * here, even when it bakes the same thing.
 */
export function matchStoredPrebuild(
  recipe: Recipe,
  prebuilds: readonly PrebuildRecord[],
): PrebuildRecord | undefined {
  const stored = storedPrebuildOf(recipe, prebuilds);
  if (!stored || !recipe.prebuild || !hasDevServers(recipe.prebuild)) {
    return stored;
  }
  const own = canonicalJson(runtimeSurfaceOf(recipe.prebuild));
  const theirs = canonicalJson(runtimeSurfaceOf(stored.spec ?? {}));
  return own === theirs ? stored : undefined;
}

/**
 * `recipe` rewritten to follow its stored prebuild by reference, when it
 * matches one but still carries a copy of its dev servers (a starter saved
 * before starters followed them, or typed in JSON mode): the same boot
 * today, but only the reference picks up later edits. Applied on save.
 * `undefined` when there's nothing to do.
 */
export function followedRecipe(
  recipe: Recipe,
  prebuilds: readonly PrebuildRecord[],
): Recipe | undefined {
  if (!recipe.prebuild || !hasDevServers(recipe.prebuild)) return undefined;
  const matched = matchStoredPrebuild(recipe, prebuilds);
  return matched ? withStoredPrebuild(recipe, matched) : undefined;
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

/** The custom form for `recipe` (also: "Customize" a followed prebuild,
 * which starts from its current dev servers, looked up in `prebuilds`). */
export function customBootOf(
  recipe: Recipe,
  defaultImage: string,
  prebuilds: readonly PrebuildRecord[] = [],
): CustomBoot {
  const source = recipe.prebuild?.source ?? recipe.source;
  return {
    image: "image" in source ? source.image : defaultImage,
    repos: recipe.prebuild?.repos ?? [],
    steps: (recipe.prebuild?.build ?? []).join("\n"),
    surface: recipeDevServers(recipe, prebuilds),
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

/**
 * The dev servers a launch of `recipe` gets from what it boots, as the
 * server resolves them (`createSandboxForUser`): the recipe's own when it
 * declares any, else the stored prebuild's current ones (followed or
 * pinned). The server adds them at launch, like a toolbox's.
 */
export function recipeDevServers(
  recipe: Recipe,
  prebuilds: readonly PrebuildRecord[],
): RuntimeSurface {
  if (recipe.prebuild && hasDevServers(recipe.prebuild)) {
    return runtimeSurfaceOf(recipe.prebuild);
  }
  return runtimeSurfaceOf(storedPrebuildOf(recipe, prebuilds)?.spec ?? {});
}

/** The public ports of `surface`, by name: what a tool tile can open. */
function publicPorts(surface: RuntimeSurface): Set<string> {
  return new Set(
    (surface.ports ?? []).filter((p) => p.public).map((p) => p.name),
  );
}

/**
 * The tools that dev servers `next` would leave with nothing to open: they
 * point at a public port of `before` that `next` drops or makes private.
 * Ports the dev servers never served (a toolbox's, the org's) aren't judged:
 * the console can't see them all.
 */
export function orphanedTools(
  services: readonly LaunchpadService[],
  before: RuntimeSurface,
  next: RuntimeSurface,
): LaunchpadService[] {
  const had = publicPorts(before);
  const has = publicPorts(next);
  return services.filter(
    (s) =>
      "port" in s.target && had.has(s.target.port) && !has.has(s.target.port),
  );
}
