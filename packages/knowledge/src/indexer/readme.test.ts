import { describe, expect, test } from "bun:test";
import { extractReadmeLede, stripFrontmatter } from "./readme.ts";

describe("stripFrontmatter", () => {
  test("removes a leading YAML block", () => {
    const md = "---\ntitle: x\n---\n\n# Hi\n\nbody\n";
    expect(stripFrontmatter(md)).toBe("\n# Hi\n\nbody\n");
  });
  test("leaves content without frontmatter untouched", () => {
    expect(stripFrontmatter("# Hi\n")).toBe("# Hi\n");
  });
});

describe("extractReadmeLede", () => {
  test("skips badges, headings and html before the first paragraph", () => {
    const md = [
      "# My Project",
      "",
      "[![CI](https://x/badge.svg)](https://x)",
      '<p align="center"><img src="logo.png" /></p>',
      "",
      "This is the real description of the project, in one paragraph",
      "that spans two lines.",
      "",
      "More stuff that should not be included.",
    ].join("\n");
    expect(extractReadmeLede(md)).toBe(
      "This is the real description of the project, in one paragraph " +
        "that spans two lines.",
    );
  });

  test("strips markdown formatting", () => {
    const md = "See [the docs](https://x) for **bold** and `code`.";
    expect(extractReadmeLede(md)).toBe("See the docs for bold and code.");
  });

  test("truncates to 300 chars", () => {
    const long = "word ".repeat(100).trim();
    const lede = extractReadmeLede(long);
    expect(lede?.length).toBeLessThanOrEqual(300);
  });

  test("returns undefined when there is no prose", () => {
    expect(extractReadmeLede("# Title\n\n![badge](x.svg)\n")).toBeUndefined();
  });
});
