import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  buildDocumentsFromWiki,
  buildOnyxDocument,
  findModulePath,
  pageLink,
  readCommit,
  readModuleTree,
  readWikiPages,
  splitSections,
} from "./pages.ts";

const fixtureDir = path.join(import.meta.dir, "__fixtures__", "wiki");

describe("readWikiPages", () => {
  test("lists top-level *.md pages, skipping temp/", async () => {
    const pages = await readWikiPages(fixtureDir);
    const stems = pages.map((p) => p.stem).sort();
    expect(stems).toEqual([
      "CI_CD_Workflows",
      "Repository_Configuration_&_Tooling",
    ]);
  });

  test("extracts the title from the first H1, else the file stem", async () => {
    const pages = await readWikiPages(fixtureDir);
    const ci = pages.find((p) => p.stem === "CI_CD_Workflows");
    expect(ci?.title).toBe("CI/CD Workflows");
  });

  test("hashes page content deterministically", async () => {
    const first = await readWikiPages(fixtureDir);
    const second = await readWikiPages(fixtureDir);
    expect(first[0]?.hash).toBe(second[0]?.hash);
    expect(first[0]?.hash).not.toBe(first[1]?.hash);
  });
});

describe("readModuleTree", () => {
  test("parses module_tree.json", async () => {
    const tree = await readModuleTree(fixtureDir);
    expect(tree.CI_CD_Workflows?.path).toBe(".github/workflows/");
  });

  test("returns {} when module_tree.json is missing", async () => {
    const tree = await readModuleTree(path.join(fixtureDir, "temp"));
    expect(tree).toEqual({});
  });
});

describe("readCommit", () => {
  test("reads generation_info.commit_id from metadata.json", async () => {
    const commit = await readCommit(fixtureDir);
    expect(commit).toBe("abc123def4567890abc123def4567890abcdef1");
  });

  test("returns undefined when metadata.json is missing", async () => {
    const commit = await readCommit(path.join(fixtureDir, "temp"));
    expect(commit).toBeUndefined();
  });
});

describe("findModulePath", () => {
  test("finds a top-level module by name", async () => {
    const tree = await readModuleTree(fixtureDir);
    expect(findModulePath(tree, "Repository_Configuration_&_Tooling")).toBe(
      ".",
    );
  });

  test("finds a nested child module", async () => {
    const tree = await readModuleTree(fixtureDir);
    expect(findModulePath(tree, "CI_CD_Workflows_Continuous_Integration")).toBe(
      ".github/workflows/",
    );
  });

  test("returns undefined for a page with no matching module", () => {
    expect(findModulePath({}, "Nonexistent")).toBeUndefined();
  });
});

describe("pageLink", () => {
  test("links to the module path at the given commit", () => {
    expect(pageLink("frak-id", "atelier", "abc123", ".github/workflows/")).toBe(
      "https://github.com/frak-id/atelier/tree/abc123/.github/workflows/",
    );
  });

  test("falls back to the repo root when there's no module path", () => {
    expect(pageLink("frak-id", "atelier", "abc123", undefined)).toBe(
      "https://github.com/frak-id/atelier/tree/abc123",
    );
  });

  test("falls back to HEAD when there's no commit", () => {
    expect(pageLink("frak-id", "atelier", undefined, undefined)).toBe(
      "https://github.com/frak-id/atelier/tree/HEAD",
    );
  });
});

describe("splitSections", () => {
  test("splits on ## headings, keeping the heading in each section", () => {
    const content = [
      "# Title",
      "",
      "intro text",
      "",
      "## First",
      "first body",
      "",
      "## Second",
      "second body",
    ].join("\n");
    const sections = splitSections(content);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toContain("# Title");
    expect(sections[1]).toContain("## First");
    expect(sections[2]).toContain("## Second");
  });

  test("a page with no ## headings is a single section", () => {
    const sections = splitSections("# Title\n\nbody only");
    expect(sections).toEqual(["# Title\n\nbody only"]);
  });
});

describe("buildOnyxDocument", () => {
  test("builds the expected id/semantic-id/metadata shape", async () => {
    const pages = await readWikiPages(fixtureDir);
    const moduleTree = await readModuleTree(fixtureDir);
    const page = pages.find((p) => p.stem === "CI_CD_Workflows");
    if (!page) throw new Error("fixture missing");

    const doc = buildOnyxDocument({
      owner: "frak-id",
      repo: "atelier",
      page,
      moduleTree,
      commit: "abc123",
      generatedAt: "2026-09-28T00:00:00.000Z",
    });

    expect(doc.id).toBe("codewiki:frak-id/atelier:CI_CD_Workflows");
    expect(doc.semanticIdentifier).toBe("atelier · CI/CD Workflows");
    expect(doc.title).toBe("CI/CD Workflows");
    expect(doc.metadata).toEqual({
      repo: "frak-id/atelier",
      generator: "codewiki",
      module: ".github/workflows/",
      commit: "abc123",
    });
    expect(doc.sections.length).toBeGreaterThan(1);
    for (const section of doc.sections) {
      expect(section.link).toBe(
        "https://github.com/frak-id/atelier/tree/abc123/.github/workflows/",
      );
    }
  });
});

describe("buildDocumentsFromWiki", () => {
  test("reads the whole wiki dir into documents", async () => {
    const { documents, pages, commit } = await buildDocumentsFromWiki(
      "frak-id",
      "atelier",
      fixtureDir,
      "2026-09-28T00:00:00.000Z",
    );
    expect(pages).toHaveLength(2);
    expect(documents).toHaveLength(2);
    expect(commit).toBe("abc123def4567890abc123def4567890abcdef1");
  });
});
