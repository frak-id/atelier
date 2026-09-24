import { describe, expect, test } from "bun:test";
import type { PrebuildSpec } from "./prebuild-spec.ts";
import { gatingProcessNames, runtimeSurfaceOf } from "./runtime-surface.ts";
import type { ProcessEntry } from "./sandbox-spec.ts";

describe("runtimeSurfaceOf", () => {
  test("keeps only processes/ports, dropping empty lists", () => {
    const web = { name: "web", command: "bun run dev" };
    const prebuild: PrebuildSpec = {
      source: { image: "dev-base" },
      build: ["make"],
      processes: [web],
      ports: [],
    };
    expect(runtimeSurfaceOf(prebuild)).toEqual({ processes: [web] });
    expect(runtimeSurfaceOf({ processes: [], ports: [] })).toEqual({});
  });
});

describe("gatingProcessNames", () => {
  const proc = (name: string, port?: number): ProcessEntry => ({
    name,
    command: name,
    ...(port ? { readiness: { port } } : {}),
  });

  test("processes probing the port, plus a same-name fallback", () => {
    const processes = [proc("kasmvnc", 6901), proc("openbox"), proc("browser")];
    expect(
      gatingProcessNames({ name: "browser", port: 6901 }, processes),
    ).toEqual(["kasmvnc", "browser"]);
  });

  test("a same-name process probing another port doesn't gate it", () => {
    expect(
      gatingProcessNames({ name: "web", port: 5173 }, [proc("web", 3000)]),
    ).toEqual([]);
  });

  test("a monorepo: each port gated by its own dev server", () => {
    const processes = [proc("web", 5173), proc("storybook", 6006)];
    expect(gatingProcessNames({ name: "docs", port: 6006 }, processes)).toEqual(
      ["storybook"],
    );
  });
});
