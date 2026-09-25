import { afterEach, describe, expect, test } from "bun:test";
import { ORG_PRINCIPAL } from "../types.ts";
import { listRepoFiles } from "./files.ts";
import { scanManifests } from "./manifests.ts";
import { cleanupFixture, writeFixture } from "./test-helpers.ts";

let root: string | undefined;
afterEach(async () => {
  if (root) await cleanupFixture(root);
  root = undefined;
});

async function scan(
  files: Record<string, string>,
  opts: Partial<Parameters<typeof scanManifests>[2]> = {},
) {
  root = await writeFixture(files);
  const listed = await listRepoFiles(root);
  return scanManifests(root, listed, {
    repo: "acme/widgets",
    revision: "abc123",
    readers: [ORG_PRINCIPAL],
    includeExternalDeps: false,
    ...opts,
  });
}

describe("scanManifests — npm workspaces", () => {
  test("repo entity, root + workspace packages, internal depends_on", async () => {
    const result = await scan({
      "README.md": "# Widgets\n\nThe widget factory.\n",
      "package.json": JSON.stringify({ name: "acme-widgets", private: true }),
      "packages/a/package.json": JSON.stringify({
        name: "@acme/a",
        version: "1.0.0",
        description: "Package A",
        dependencies: { "@acme/b": "workspace:*", lodash: "^4.0.0" },
      }),
      "packages/b/package.json": JSON.stringify({
        name: "@acme/b",
        version: "1.0.0",
      }),
    });

    const repo = result.entities.find((e) => e.id === "repo:acme/widgets");
    expect(repo?.summary).toBe("The widget factory.");
    expect(repo?.attrs).toEqual({ revision: "abc123" });

    expect(result.npmPackages.map((p) => p.entityId).sort()).toEqual([
      "package:@acme/a",
      "package:@acme/b",
      "package:acme-widgets",
    ]);

    const a = result.entities.find((e) => e.id === "package:@acme/a");
    expect(a?.summary).toBe("Package A");
    expect(a?.attrs).toEqual({
      path: "packages/a",
      version: "1.0.0",
      private: false,
      ecosystem: "npm",
    });

    expect(result.facts).toContainEqual({
      type: "depends_on",
      from: "package:@acme/a",
      to: "package:@acme/b",
      attrs: { kind: "dependencies" },
      readers: [ORG_PRINCIPAL],
    });
    // external dep skipped without includeExternalDeps
    expect(result.entities.some((e) => e.id === "dependency:npm:lodash")).toBe(
      false,
    );
    expect(result.facts.some((f) => f.to === "dependency:npm:lodash")).toBe(
      false,
    );

    expect(result.facts).toContainEqual({
      type: "contains",
      from: "repo:acme/widgets",
      to: "package:@acme/a",
      attrs: {},
      readers: [ORG_PRINCIPAL],
    });
    expect(result.warnings).toEqual([]);
  });

  test("includeExternalDeps emits dependency entities and facts", async () => {
    const result = await scan(
      {
        "package.json": JSON.stringify({ name: "root" }),
        "packages/a/package.json": JSON.stringify({
          name: "@acme/a",
          dependencies: { lodash: "^4.0.0" },
        }),
      },
      { includeExternalDeps: true },
    );
    expect(
      result.entities.find((e) => e.id === "dependency:npm:lodash"),
    ).toMatchObject({ type: "dependency", name: "lodash" });
    expect(result.facts).toContainEqual({
      type: "depends_on",
      from: "package:@acme/a",
      to: "dependency:npm:lodash",
      attrs: { kind: "dependencies" },
      readers: [ORG_PRINCIPAL],
    });
  });

  test("nested package.json without a name is warned and skipped", async () => {
    const result = await scan({
      "package.json": JSON.stringify({ name: "root" }),
      "libs/thing/package.json": "{}",
    });
    expect(result.warnings).toContain(
      "package.json without a name: libs/thing/package.json",
    );
  });

  test("unparseable package.json is a warning, not a throw", async () => {
    const result = await scan({
      "package.json": JSON.stringify({ name: "root" }),
      "packages/broken/package.json": "{not json",
    });
    expect(result.warnings.some((w) => w.includes("broken/package.json"))).toBe(
      true,
    );
  });
});

describe("scanManifests — Cargo crates", () => {
  test("path and name deps resolve to internal crates; workspace root is not a crate", async () => {
    const result = await scan({
      "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
      "crates/core/Cargo.toml":
        '[package]\nname = "widgets-core"\nversion = "0.1.0"\n',
      "crates/cli/Cargo.toml": [
        "[package]",
        'name = "widgets-cli"',
        'version = "0.1.0"',
        "",
        "[dependencies]",
        'widgets-core = { path = "../core" }',
        'serde = "1"',
      ].join("\n"),
    });

    expect(result.crates.map((c) => c.entityId).sort()).toEqual([
      "crate:widgets-cli",
      "crate:widgets-core",
    ]);
    expect(result.entities.some((e) => e.id === "crate:workspace")).toBe(false);
    expect(result.facts).toContainEqual({
      type: "depends_on",
      from: "crate:widgets-cli",
      to: "crate:widgets-core",
      attrs: { kind: "dependencies" },
      readers: [ORG_PRINCIPAL],
    });
    // external crate dep never turned into a fact (path/name didn't match)
    expect(result.facts.some((f) => f.to === "crate:serde")).toBe(false);
  });
});

describe("scanManifests — python & go (minimal)", () => {
  test("pyproject.toml [project].name", async () => {
    const result = await scan({
      "svc/pyproject.toml":
        '[project]\nname = "widgets-svc"\nversion = "0.1.0"\n',
    });
    expect(
      result.entities.find((e) => e.id === "package:pypi:widgets-svc"),
    ).toMatchObject({
      attrs: { path: "svc", version: "0.1.0", ecosystem: "pypi" },
    });
  });

  test("go.mod module line", async () => {
    const result = await scan({
      "tool/go.mod": "module github.com/acme/tool\n\ngo 1.22\n",
    });
    expect(
      result.entities.find((e) => e.id === "package:go:github.com/acme/tool"),
    ).toMatchObject({ attrs: { path: "tool", ecosystem: "go" } });
  });
});
