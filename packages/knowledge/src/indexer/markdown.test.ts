import { afterEach, describe, expect, test } from "bun:test";
import { ORG_PRINCIPAL } from "../types.ts";
import { buildDocuments, githubSlug } from "./markdown.ts";
import { cleanupFixture, writeFixture } from "./test-helpers.ts";

let root: string | undefined;
afterEach(async () => {
  if (root) await cleanupFixture(root);
  root = undefined;
});

describe("githubSlug", () => {
  test("lowercases, hyphenates, drops punctuation", () => {
    expect(githubSlug("Getting Started!")).toBe("getting-started");
    expect(githubSlug("API & CLI")).toBe("api--cli");
  });
});

async function scan(files: Record<string, string>) {
  root = await writeFixture(files);
  return buildDocuments(root, Object.keys(files), {
    repo: "acme/widgets",
    revision: "deadbeef",
    webUrl: "https://github.com/acme/widgets/blob/deadbeef",
    readers: [ORG_PRINCIPAL],
    owners: [],
  });
}

describe("buildDocuments", () => {
  test("frontmatter is dropped, intro chunk uses the first H1", () => {
    return scan({
      "docs/guide.md": [
        "---",
        "title: Guide",
        "---",
        "# The Guide",
        "",
        "Intro text before any subheading.",
        "",
        "## Setup",
        "",
        "Do the setup.",
      ].join("\n"),
    }).then(({ documents, warnings }) => {
      expect(warnings).toEqual([]);
      expect(documents).toHaveLength(2);
      const intro = documents.find((d) => d.id.endsWith("#the-guide"));
      expect(intro?.title).toBe("docs/guide.md › The Guide");
      expect(intro?.body).toContain("Intro text");
      expect(intro?.body).not.toContain("title: Guide");
      const setup = documents.find((d) => d.id.endsWith("#setup"));
      expect(setup?.title).toBe("docs/guide.md › The Guide › Setup");
      expect(setup?.url).toBe(
        "https://github.com/acme/widgets/blob/deadbeef/docs/guide.md#setup",
      );
      expect(setup?.entityIds).toEqual(["repo:acme/widgets"]);
      expect(setup?.revision).toBe("deadbeef");
    });
  });

  test("content with no heading before it falls back to the filename", () => {
    return scan({ "notes.md": "just a note, no headings here" }).then(
      ({ documents }) => {
        expect(documents).toHaveLength(1);
        expect(documents[0]?.id).toBe("doc:acme/widgets:notes.md#notesmd");
        expect(documents[0]?.title).toBe("notes.md › notes.md");
      },
    );
  });

  test("duplicate headings get GitHub-style -1, -2 suffixes", () => {
    return scan({
      "docs/x.md": [
        "# X",
        "intro content",
        "## Usage",
        "first",
        "## Usage",
        "second",
        "## Usage",
        "third",
      ].join("\n"),
    }).then(({ documents }) => {
      const ids = documents.map((d) => d.id).sort();
      expect(ids).toEqual([
        "doc:acme/widgets:docs/x.md#usage",
        "doc:acme/widgets:docs/x.md#usage-1",
        "doc:acme/widgets:docs/x.md#usage-2",
        "doc:acme/widgets:docs/x.md#x",
      ]);
    });
  });

  test("oversized chunks are split on paragraph boundaries", () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) =>
      `Paragraph ${i} `.repeat(10),
    );
    const body = ["# Big", ...paragraphs].join("\n\n");
    return scan({ "docs/big.md": body }).then(({ documents }) => {
      expect(documents.length).toBeGreaterThan(1);
      for (const doc of documents)
        expect(doc.body.length).toBeLessThanOrEqual(2500);
      const ids = documents.map((d) => d.id);
      expect(ids).toContain("doc:acme/widgets:docs/big.md#big");
      expect(ids).toContain("doc:acme/widgets:docs/big.md#big-2");
    });
  });

  test("headings inside fenced code blocks are not chunk boundaries", () => {
    return scan({
      "docs/fence.md": [
        "# Title",
        "",
        "```md",
        "# not a heading",
        "```",
        "",
        "real content",
      ].join("\n"),
    }).then(({ documents }) => {
      expect(documents).toHaveLength(1);
      expect(documents[0]?.body).toContain("# not a heading");
    });
  });

  test("skips files over the size cap and non-markdown files", () => {
    return scan({ "docs/a.md": "# A\ncontent", "docs/a.txt": "ignored" }).then(
      ({ documents }) => {
        expect(documents.every((d) => d.path === "docs/a.md")).toBe(true);
      },
    );
  });
});
