import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ORG_PRINCIPAL } from "../types.ts";
import { indexRepository } from "./index.ts";
import { cleanupFixture, writeFixture } from "./test-helpers.ts";

let root: string | undefined;
afterEach(async () => {
  if (root) await cleanupFixture(root);
  root = undefined;
});

const FIXTURE = {
  ".github/CODEOWNERS": [
    "* @org/platform",
    "/apps/console/ @org/frontend",
  ].join("\n"),
  "README.md": [
    "# Widgets Monorepo",
    "",
    "[![CI](https://x/badge.svg)](https://x)",
    "",
    "A monorepo of fine widgets and gizmos.",
  ].join("\n"),
  "package.json": JSON.stringify({ name: "widgets-root", private: true }),
  "apps/console/package.json": JSON.stringify({
    name: "@acme/console",
    version: "1.0.0",
    dependencies: { "@acme/shared": "workspace:*" },
  }),
  "apps/console/src/index.ts": [
    'import { helper } from "@acme/shared";',
    'import { local } from "./local";',
  ].join("\n"),
  "apps/console/src/local.ts": "export const local = 1;",
  "packages/shared/package.json": JSON.stringify({
    name: "@acme/shared",
    version: "1.0.0",
  }),
  "packages/shared/src/index.ts": "export const helper = 1;",
  "crates/core/Cargo.toml":
    '[package]\nname = "widgets-core"\nversion = "0.1.0"\n',
  "docs/architecture.md": [
    "# Architecture",
    "",
    "## Overview",
    "",
    "How it all fits together.",
  ].join("\n"),
};

describe("indexRepository (no .git → walk fallback)", () => {
  test("assembles entities, facts and documents end to end", async () => {
    root = await writeFixture(FIXTURE);
    const result = await indexRepository({
      root,
      repo: "acme/widgets",
      revision: "rev1",
      webUrl: "https://github.com/acme/widgets/blob/rev1",
      includeFiles: true,
    });

    expect(result.repo).toBe("acme/widgets");
    expect(result.warnings).toEqual([]);

    const ids = result.entities.map((e) => e.id);
    expect(ids).toContain("repo:acme/widgets");
    expect(ids).toContain("package:@acme/console");
    expect(ids).toContain("package:@acme/shared");
    expect(ids).toContain("crate:widgets-core");
    expect(ids).toContain("team:platform");
    expect(ids).toContain("team:frontend");

    const repo = result.entities.find((e) => e.id === "repo:acme/widgets");
    expect(repo?.summary).toBe("A monorepo of fine widgets and gizmos.");

    expect(result.facts).toContainEqual({
      type: "depends_on",
      from: "package:@acme/console",
      to: "package:@acme/shared",
      attrs: { kind: "dependencies" },
      readers: [ORG_PRINCIPAL],
    });
    expect(result.facts).toContainEqual({
      type: "imports",
      from: "package:@acme/console",
      to: "package:@acme/shared",
      attrs: { files: 1 },
      readers: [ORG_PRINCIPAL],
    });
    expect(result.facts).toContainEqual({
      type: "imports",
      from: "file:acme/widgets:apps/console/src/index.ts",
      to: "file:acme/widgets:apps/console/src/local.ts",
      attrs: {},
      readers: [ORG_PRINCIPAL],
    });
    expect(result.facts).toContainEqual({
      type: "owns",
      from: "team:frontend",
      to: "package:@acme/console",
      attrs: { pattern: "/apps/console/" },
      readers: [ORG_PRINCIPAL],
    });
    expect(result.facts).toContainEqual({
      type: "owns",
      from: "team:platform",
      to: "repo:acme/widgets",
      attrs: { pattern: "*" },
      readers: [ORG_PRINCIPAL],
    });
    // packages/shared has no CODEOWNERS rule of its own, so it falls back
    // to the repo-wide catch-all ("*" matches every path).
    expect(result.facts).toContainEqual({
      type: "owns",
      from: "team:platform",
      to: "package:@acme/shared",
      attrs: { pattern: "*" },
      readers: [ORG_PRINCIPAL],
    });

    const doc = result.documents.find((d) =>
      d.id.startsWith("doc:acme/widgets:docs/architecture.md#overview"),
    );
    expect(doc?.title).toBe("docs/architecture.md › Architecture › Overview");
    // the root package.json (dir "") is the deepest package containing
    // any top-level doc, so it owns docs/architecture.md too.
    expect(doc?.entityIds).toEqual([
      "package:widgets-root",
      "repo:acme/widgets",
    ]);

    expect(result.stats.documents).toBe(result.documents.length);
    expect(result.stats.files).toBeGreaterThan(0);
    expect(result.stats.packages).toBe(4); // console, shared, root, core
  });

  test("is deterministic across runs (ignoring durationMs)", async () => {
    root = await writeFixture(FIXTURE);
    const input = {
      root,
      repo: "acme/widgets",
      revision: "rev1",
      includeFiles: true,
    };
    const first = await indexRepository(input);
    const second = await indexRepository(input);
    const strip = (r: typeof first) => ({
      ...r,
      stats: { ...r.stats, durationMs: 0 },
    });
    expect(strip(first)).toEqual(strip(second));
  });

  test("defaults readers to [org] and respects custom readers", async () => {
    root = await writeFixture({
      "package.json": JSON.stringify({ name: "root" }),
    });
    const result = await indexRepository({
      root,
      repo: "acme/x",
      revision: "r1",
      readers: ["team:secret"],
    });
    expect(result.entities.length).toBeGreaterThan(0);
    for (const e of result.entities) expect(e.readers).toEqual(["team:secret"]);
  });
});

describe("indexRepository (.git present → git ls-files path)", () => {
  test("uses git ls-files for the walk", async () => {
    root = await writeFixture({
      "package.json": JSON.stringify({ name: "root" }),
      "src/index.ts": "export const x = 1;",
      "ignored.txt": "nope",
      ".gitignore": "ignored.txt\n",
    });
    Bun.spawnSync(["git", "-C", root, "init", "--quiet"]);
    Bun.spawnSync(["git", "-C", root, "config", "user.email", "t@t.co"]);
    Bun.spawnSync(["git", "-C", root, "config", "user.name", "t"]);
    Bun.spawnSync(["git", "-C", root, "add", "-A"]);
    Bun.spawnSync(["git", "-C", root, "commit", "-q", "-m", "init"]);

    const result = await indexRepository({
      root,
      repo: "acme/gitrepo",
      revision: "rev1",
    });
    expect(result.entities.some((e) => e.id === "package:root")).toBe(true);
    expect(result.stats.files).toBeGreaterThan(0);
  });
});

describe("indexRepository — smoke test on this monorepo", () => {
  test("extracts known cross-package facts and docs from the real repo", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../..");
    const result = await indexRepository({
      root: repoRoot,
      repo: "frak-id/atelier",
      revision: "smoke",
      includeFiles: true,
    });

    expect(result.facts).toContainEqual(
      expect.objectContaining({
        type: "depends_on",
        from: "package:@atelier/server",
        to: "package:@atelier/spec",
      }),
    );
    expect(result.facts).toContainEqual(
      expect.objectContaining({
        type: "imports",
        from: "package:@atelier/server",
        to: "package:@atelier/spec",
      }),
    );
    expect(
      result.entities.some(
        (e) => e.type === "crate" && e.attrs.path === "apps/agent-v2",
      ),
    ).toBe(true);
    expect(
      result.documents.some((d) => d.path === "docs/architecture.md"),
    ).toBe(true);
  }, 5_000);
});
