import { afterEach, describe, expect, test } from "bun:test";
import { ORG_PRINCIPAL } from "../types.ts";
import { listRepoFiles } from "./files.ts";
import { scanImports } from "./imports.ts";
import { cleanupFixture, writeFixture } from "./test-helpers.ts";

let root: string | undefined;
afterEach(async () => {
  if (root) await cleanupFixture(root);
  root = undefined;
});

describe("scanImports", () => {
  test("static, subpath and dynamic imports become package-level facts; commented-out imports are ignored", async () => {
    root = await writeFixture({
      "packages/a/package.json": JSON.stringify({ name: "@acme/a" }),
      "packages/a/src/index.ts": [
        'import { thing } from "@acme/b";',
        'import deep from "@acme/b/lib/deep";',
        '// import { unused } from "@acme/b";',
        "/* import x from '@acme/b'; */",
        "async function load() {",
        '  const mod = await import("@acme/b");',
        "  return mod;",
        "}",
        "export { thing };",
      ].join("\n"),
      "packages/b/package.json": JSON.stringify({ name: "@acme/b" }),
      "packages/b/src/index.ts": "export const thing = 1;",
    });
    const files = await listRepoFiles(root);
    const result = await scanImports(root, {
      repo: "acme/widgets",
      files,
      npmPackages: [
        { entityId: "package:@acme/a", name: "@acme/a", dir: "packages/a" },
        { entityId: "package:@acme/b", name: "@acme/b", dir: "packages/b" },
      ],
      crates: [],
      readers: [ORG_PRINCIPAL],
      includeFiles: false,
    });
    const importFact = result.facts.find((f) => f.type === "imports");
    expect(importFact).toEqual({
      type: "imports",
      from: "package:@acme/a",
      to: "package:@acme/b",
      attrs: { files: 1 },
      readers: [ORG_PRINCIPAL],
    });
  });

  test("includeFiles emits file entities, package-contains-file and file-imports-file for relative specifiers", async () => {
    root = await writeFixture({
      "packages/a/package.json": JSON.stringify({ name: "@acme/a" }),
      "packages/a/src/index.ts": [
        'import { helper } from "./helper";',
        'import { other } from "../lib/other.js";',
      ].join("\n"),
      "packages/a/src/helper.ts": "export const helper = 1;",
      "packages/a/lib/other.js": "export const other = 2;",
    });
    const files = await listRepoFiles(root);
    const result = await scanImports(root, {
      repo: "acme/widgets",
      files,
      npmPackages: [
        { entityId: "package:@acme/a", name: "@acme/a", dir: "packages/a" },
      ],
      crates: [],
      readers: [ORG_PRINCIPAL],
      includeFiles: true,
    });

    const fileIds = result.entities.map((e) => e.id).sort();
    expect(fileIds).toEqual([
      "file:acme/widgets:packages/a/lib/other.js",
      "file:acme/widgets:packages/a/src/helper.ts",
      "file:acme/widgets:packages/a/src/index.ts",
    ]);
    expect(result.facts).toContainEqual({
      type: "contains",
      from: "package:@acme/a",
      to: "file:acme/widgets:packages/a/src/index.ts",
      attrs: {},
      readers: [ORG_PRINCIPAL],
    });
    expect(result.facts).toContainEqual({
      type: "imports",
      from: "file:acme/widgets:packages/a/src/index.ts",
      to: "file:acme/widgets:packages/a/src/helper.ts",
      attrs: {},
      readers: [ORG_PRINCIPAL],
    });
    expect(result.facts).toContainEqual({
      type: "imports",
      from: "file:acme/widgets:packages/a/src/index.ts",
      to: "file:acme/widgets:packages/a/lib/other.js",
      attrs: {},
      readers: [ORG_PRINCIPAL],
    });
  });
});
