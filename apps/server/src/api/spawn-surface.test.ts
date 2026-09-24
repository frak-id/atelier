import { describe, expect, test } from "bun:test";
import type { PortEntry, ProcessEntry } from "@atelier/spec";
import { spawnSurface } from "./spawn-surface.ts";

const proc = (name: string, command = name): ProcessEntry => ({
  name,
  command,
});
const port = (name: string, n: number): PortEntry => ({
  name,
  port: n,
  public: true,
});

describe("spawnSurface", () => {
  test("a prebuild's dev servers sit next to its toolboxes' tools", () => {
    const surface = spawnSurface({
      prebuild: {
        processes: [proc("web"), proc("storybook")],
        ports: [port("web", 5173), port("storybook", 6006)],
      },
      toolboxes: { processes: [proc("pi-web")], ports: [port("pi", 4096)] },
      own: {},
    });
    expect(surface.processes?.map((p) => p.name)).toEqual([
      "web",
      "storybook",
      "pi-web",
    ]);
    expect(surface.ports?.map((p) => p.name)).toEqual([
      "web",
      "storybook",
      "pi",
    ]);
    expect(surface.shadowed).toEqual([]);
  });

  test("a toolbox beats a prebuild on a clash, and says so", () => {
    const surface = spawnSurface({
      prebuild: {
        processes: [proc("pi-web", "bun run dev")],
        ports: [port("pi", 3000)],
      },
      toolboxes: {
        processes: [proc("pi-web", "pi-web serve")],
        ports: [port("pi", 4096)],
      },
      own: {},
    });
    expect(surface.processes).toEqual([proc("pi-web", "pi-web serve")]);
    expect(surface.ports).toEqual([port("pi", 4096)]);
    expect(surface.shadowed).toEqual(["pi-web", "port pi"]);
  });

  test("the spec's own entries beat both", () => {
    const surface = spawnSurface({
      prebuild: { processes: [proc("web", "bun run dev")] },
      toolboxes: { processes: [proc("web", "toolbox")] },
      own: { processes: [proc("web", "mine")] },
    });
    expect(surface.processes).toEqual([proc("web", "mine")]);
  });

  test("two toolboxes declaring one name apply once, the later winning", () => {
    const surface = spawnSurface({
      toolboxes: { processes: [proc("x", "first"), proc("x", "second")] },
      own: {},
    });
    expect(surface.processes).toEqual([proc("x", "second")]);
  });

  test("nothing declared leaves the spec without processes/ports", () => {
    expect(spawnSurface({ toolboxes: {}, own: {} })).toEqual({ shadowed: [] });
  });
});
