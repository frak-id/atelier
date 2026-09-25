import { describe, expect, test } from "bun:test";
import {
  type LaunchpadService,
  type PrebuildRecord,
  type PrebuildSpec,
  runtimeSurfaceOf,
  type StarterInput,
  withoutSurface,
} from "@atelier/spec";
import {
  blankStarterInput,
  bootMode,
  customBootOf,
  followedRecipe,
  matchStoredPrebuild,
  orphanedTools,
  recipeDevServers,
  withCustomBoot,
  withStoredPrebuild,
} from "./starter-recipe";

const devSpec: PrebuildSpec = {
  source: { image: "dev-base" },
  repos: [
    { url: "https://github.com/acme/web", clonePath: "web" },
    { url: "https://github.com/acme/api", branch: "dev", clonePath: "api" },
  ],
  build: ["cd web && bun install"],
  env: { CI: "1" },
  processes: [
    { name: "web", command: "bun run dev", cwd: "/home/dev/web", lazy: true },
  ],
  ports: [{ name: "web", port: 5173, public: true }],
};
const devPrebuild: PrebuildRecord = {
  ref: "snap-dev",
  hash: "h",
  image: "dev-base:latest",
  createdAt: "2026-01-01T00:00:00.000Z",
  spec: devSpec,
};
const handMade: PrebuildRecord = {
  ref: "snap-hand",
  hash: "h2",
  image: "dev-base:latest",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const recipe = (): StarterInput["recipe"] =>
  blankStarterInput("dev-base").recipe;
const devSurface = runtimeSurfaceOf(devSpec);
/** `devPrebuild` after its dev servers were edited on the prebuild. */
const editedPrebuild: PrebuildRecord = {
  ...devPrebuild,
  spec: {
    ...devSpec,
    processes: [{ name: "web", command: "bun run start", lazy: true }],
    ports: [{ name: "web", port: 3000, public: true }],
  },
};

describe("stored prebuilds", () => {
  test("a prebuild with a spec is followed, a hand-made one pinned", () => {
    const followed = withStoredPrebuild(recipe(), devPrebuild);
    // Followed by reference: the recipe, without the dev servers.
    expect(followed.prebuild).toEqual(withoutSurface(devSpec));
    expect(followed.prebuild?.processes).toBeUndefined();
    expect(matchStoredPrebuild(followed, [devPrebuild])).toBe(devPrebuild);
    expect(bootMode(followed, [devPrebuild])).toBe("stored");

    const pinned = withStoredPrebuild(followed, handMade);
    expect(pinned.prebuild).toBeUndefined();
    expect(pinned.source).toEqual({ snapshot: "snap-hand" });
    expect(bootMode(pinned, [])).toBe("stored"); // even once it's gone
  });

  test("a followed spec matches whatever its key order", () => {
    const { source, ...rest } = devSpec;
    const reordered = { ...recipe(), prebuild: { ...rest, source } };
    expect(matchStoredPrebuild(reordered, [devPrebuild])).toBe(devPrebuild);
  });

  test("editing the prebuild's dev servers keeps it followed", () => {
    const followed = withStoredPrebuild(recipe(), devPrebuild);
    expect(matchStoredPrebuild(followed, [editedPrebuild])).toBe(
      editedPrebuild,
    );
    expect(bootMode(followed, [editedPrebuild])).toBe("stored");
    // …and a launch gets the edited ones.
    expect(recipeDevServers(followed, [editedPrebuild]).ports).toEqual(
      editedPrebuild.spec?.ports,
    );
  });

  test("metadata never tells two recipes apart", () => {
    const followed = withStoredPrebuild(recipe(), devPrebuild);
    const rebaked = {
      ...devPrebuild,
      ref: "snap-dev-2",
      spec: { ...devSpec, metadata: { a: "b" } },
    };
    expect(matchStoredPrebuild(followed, [rebaked])).toBe(rebaked);
  });

  test("a copy of the dev servers (saved before) is rewritten to follow", () => {
    const legacy = { ...recipe(), prebuild: devSpec };
    expect(bootMode(legacy, [devPrebuild])).toBe("stored");
    expect(followedRecipe(legacy, [devPrebuild])).toEqual(
      withStoredPrebuild(legacy, devPrebuild),
    );
    // Nothing to rewrite once it follows.
    const followed = withStoredPrebuild(recipe(), devPrebuild);
    expect(followedRecipe(followed, [devPrebuild])).toBeUndefined();
  });

  test("a copy that differs is the starter's own set-up", () => {
    const legacy = { ...recipe(), prebuild: devSpec };
    expect(matchStoredPrebuild(legacy, [editedPrebuild])).toBeUndefined();
    expect(bootMode(legacy, [editedPrebuild])).toBe("custom");
    expect(followedRecipe(legacy, [editedPrebuild])).toBeUndefined();
    // Its own dev servers win at launch, like on the server.
    expect(recipeDevServers(legacy, [editedPrebuild])).toEqual(devSurface);
  });

  test("resources survive switching the boot source", () => {
    const followed = withStoredPrebuild(recipe(), devPrebuild);
    expect(followed.resources).toEqual({ vcpus: 2, memoryMb: 4096 });
  });
});

describe("set it up here", () => {
  test("nothing to clone or build boots the image directly", () => {
    const next = withCustomBoot(recipe(), {
      image: "rust",
      repos: [{ url: " ", clonePath: "blank" }],
      steps: "\n  \n",
      surface: {},
    });
    expect(next.source).toEqual({ image: "rust" });
    expect(next.prebuild).toBeUndefined();
    expect(bootMode(next, [devPrebuild])).toBe("custom");
  });

  test("repos and steps become an inline prebuild, cleaned", () => {
    const next = withCustomBoot(recipe(), {
      image: "dev-base",
      repos: [{ url: "https://github.com/acme/web", clonePath: "web" }],
      steps: "cd web && bun install \n\n  cd web && bun run build",
      surface: {},
    });
    expect(next.prebuild).toEqual({
      source: { image: "dev-base" },
      repos: [{ url: "https://github.com/acme/web", clonePath: "web" }],
      build: ["cd web && bun install", "cd web && bun run build"],
    });
    expect(next.source).toEqual({ image: "dev-base" });
  });

  test("Customize round-trips a stored prebuild, keeping env/files", () => {
    const followed = withStoredPrebuild(recipe(), devPrebuild);
    const boot = customBootOf(followed, "fallback", [devPrebuild]);
    expect(boot.image).toBe("dev-base");
    expect(boot.repos).toHaveLength(2);
    expect(boot.steps).toBe("cd web && bun install");
    const edited = withCustomBoot(followed, {
      ...boot,
      steps: `${boot.steps}\ncd api && make`,
    });
    expect(edited.prebuild?.env).toEqual({ CI: "1" });
    // The dev servers come along, and stay editable.
    expect(boot.surface.ports).toEqual(devSpec.ports);
    expect(edited.prebuild?.processes).toEqual(devSpec.processes);
    expect(edited.prebuild?.build).toHaveLength(2);
    // Now differs from the stored spec: it's the starter's own set-up.
    expect(bootMode(edited, [devPrebuild])).toBe("custom");
  });
});

describe("recipeDevServers", () => {
  test("the followed or pinned prebuild's current ones, or none", () => {
    const followed = withStoredPrebuild(recipe(), devPrebuild);
    expect(recipeDevServers(followed, [devPrebuild])).toEqual(devSurface);
    // The list not loaded (or the prebuild deleted): nothing known.
    expect(recipeDevServers(followed, [])).toEqual({});
    const pinnedToDev = { ...recipe(), source: { snapshot: "snap-dev" } };
    expect(recipeDevServers(pinnedToDev, [devPrebuild])).toEqual(devSurface);
    expect(recipeDevServers(recipe(), [devPrebuild])).toEqual({});
  });

  test("a recipe's own win", () => {
    const own = withCustomBoot(recipe(), {
      image: "dev-base",
      repos: devSpec.repos ?? [],
      steps: "cd web && bun install",
      surface: { ports: [{ name: "docs", port: 4000, public: true }] },
    });
    expect(recipeDevServers(own, [devPrebuild])).toEqual({
      ports: [{ name: "docs", port: 4000, public: true }],
    });
  });
});

describe("orphanedTools", () => {
  const tool = (id: string, port: string): LaunchpadService => ({
    id,
    label: id,
    target: { port },
  });
  const preview = tool("preview", "web");
  const services = [
    preview,
    tool("assistant", "pi"),
    { id: "docs", label: "Docs", target: { url: "https://docs.acme.dev" } },
  ];

  test("a dropped or now-private port orphans its tools", () => {
    expect(orphanedTools(services, devSurface, {})).toEqual([preview]);
    const privateWeb = {
      ...devSurface,
      ports: [{ name: "web", port: 5173 }],
    };
    expect(orphanedTools(services, devSurface, privateWeb)).toEqual([preview]);
  });

  test("a kept port, or one the dev servers never served, doesn't", () => {
    expect(orphanedTools(services, devSurface, devSurface)).toEqual([]);
    // `pi` is a toolbox's: not the dev servers' to break.
    expect(orphanedTools([tool("a", "pi")], devSurface, {})).toEqual([]);
  });
});
