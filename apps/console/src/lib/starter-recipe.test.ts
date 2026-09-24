import { describe, expect, test } from "bun:test";
import type { PrebuildRecord, StarterInput } from "@atelier/spec";
import {
  blankStarterInput,
  bootMode,
  customBootOf,
  matchStoredPrebuild,
  recipePrebuildSpec,
  withCustomBoot,
  withStoredPrebuild,
} from "./starter-recipe";

const devPrebuild: PrebuildRecord = {
  ref: "snap-dev",
  hash: "h",
  image: "dev-base:latest",
  createdAt: "2026-01-01T00:00:00.000Z",
  spec: {
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
  },
};
const handMade: PrebuildRecord = {
  ref: "snap-hand",
  hash: "h2",
  image: "dev-base:latest",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const recipe = (): StarterInput["recipe"] =>
  blankStarterInput("dev-base").recipe;

describe("stored prebuilds", () => {
  test("a prebuild with a spec is followed, a hand-made one pinned", () => {
    const followed = withStoredPrebuild(recipe(), devPrebuild);
    expect(followed.prebuild).toEqual(devPrebuild.spec);
    expect(matchStoredPrebuild(followed, [devPrebuild])).toBe(devPrebuild);
    expect(bootMode(followed, [devPrebuild])).toBe("stored");

    const pinned = withStoredPrebuild(followed, handMade);
    expect(pinned.prebuild).toBeUndefined();
    expect(pinned.source).toEqual({ snapshot: "snap-hand" });
    expect(bootMode(pinned, [])).toBe("stored"); // even once it's gone
  });

  test("a followed spec matches whatever its key order", () => {
    const { source, ...rest } = devPrebuild.spec ?? { source: { image: "" } };
    const reordered = { ...recipe(), prebuild: { ...rest, source } };
    expect(matchStoredPrebuild(reordered, [devPrebuild])).toBe(devPrebuild);
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
    const boot = customBootOf(followed, "fallback");
    expect(boot.image).toBe("dev-base");
    expect(boot.repos).toHaveLength(2);
    expect(boot.steps).toBe("cd web && bun install");
    const edited = withCustomBoot(followed, {
      ...boot,
      steps: `${boot.steps}\ncd api && make`,
    });
    expect(edited.prebuild?.env).toEqual({ CI: "1" });
    // The dev servers come along, and stay editable.
    expect(boot.surface.ports).toEqual(devPrebuild.spec?.ports);
    expect(edited.prebuild?.processes).toEqual(devPrebuild.spec?.processes);
    expect(edited.prebuild?.build).toHaveLength(2);
    // Now differs from the stored spec: it's the starter's own set-up.
    expect(bootMode(edited, [devPrebuild])).toBe("custom");
  });
});

describe("recipePrebuildSpec", () => {
  test("its own recipe, the pinned stored one, or none", () => {
    const followed = withStoredPrebuild(recipe(), devPrebuild);
    expect(recipePrebuildSpec(followed, [])).toBe(devPrebuild.spec);
    const pinnedToDev = { ...recipe(), source: { snapshot: "snap-dev" } };
    expect(recipePrebuildSpec(pinnedToDev, [devPrebuild])).toBe(
      devPrebuild.spec,
    );
    expect(recipePrebuildSpec(recipe(), [devPrebuild])).toBeUndefined();
  });
});
