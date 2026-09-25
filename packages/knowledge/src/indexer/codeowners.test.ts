import { describe, expect, test } from "bun:test";
import {
  matchesPattern,
  ownerEntityId,
  parseCodeowners,
  resolveOwners,
} from "./codeowners.ts";

describe("matchesPattern", () => {
  test("anchored patterns only match at root", () => {
    expect(matchesPattern("/apps/server", "apps/server")).toBe(true);
    expect(matchesPattern("/apps/server", "libs/apps/server")).toBe(false);
  });

  test("unanchored patterns match at any depth (basename)", () => {
    expect(matchesPattern("server", "apps/server")).toBe(true);
    expect(matchesPattern("server", "apps/server/index.ts")).toBe(true);
    expect(matchesPattern("server", "apps/serverx")).toBe(false);
  });

  test("* matches within a segment, not across /", () => {
    expect(matchesPattern("apps/*", "apps/server")).toBe(true);
    expect(matchesPattern("apps/*", "apps/server/index.ts")).toBe(true);
    expect(matchesPattern("apps/*.ts", "apps/index.ts")).toBe(true);
    expect(matchesPattern("apps/*.ts", "apps/sub/index.ts")).toBe(false);
  });

  test("** matches across directories", () => {
    expect(matchesPattern("apps/**", "apps/a/b/c.ts")).toBe(true);
    expect(matchesPattern("/docs/**/*.md", "docs/a/b/c.md")).toBe(true);
  });

  test("? matches a single non-slash character", () => {
    expect(matchesPattern("a?c", "abc")).toBe(true);
    expect(matchesPattern("a?c", "ac")).toBe(false);
    expect(matchesPattern("a?c", "a/c")).toBe(false);
  });

  test("catch-all patterns", () => {
    expect(matchesPattern("*", "anything/at/all")).toBe(true);
    expect(matchesPattern("/**", "anything/at/all")).toBe(true);
  });
});

describe("parseCodeowners", () => {
  test("skips blanks and comments, splits pattern from owners", () => {
    const rules = parseCodeowners(
      [
        "# top-level",
        "",
        "* @org/platform",
        "/apps/console/ @org/frontend @alice",
      ].join("\n"),
    );
    expect(rules).toEqual([
      { pattern: "*", owners: ["@org/platform"] },
      {
        pattern: "/apps/console/",
        owners: ["@org/frontend", "@alice"],
      },
    ]);
  });
});

describe("resolveOwners (last matching rule wins)", () => {
  const rules = parseCodeowners(
    [
      "* @org/platform",
      "/apps/ @org/apps",
      "/apps/console/ @org/frontend",
    ].join("\n"),
  );

  test("more specific rule overrides earlier broader ones", () => {
    expect(resolveOwners(rules, "apps/console")?.owners).toEqual([
      "@org/frontend",
    ]);
    expect(resolveOwners(rules, "apps/server")?.owners).toEqual(["@org/apps"]);
    expect(resolveOwners(rules, "packages/spec")?.owners).toEqual([
      "@org/platform",
    ]);
  });

  test("root resolves to the catch-all", () => {
    expect(resolveOwners(rules, "")?.pattern).toBe("*");
  });
});

describe("ownerEntityId", () => {
  test("@org/team → team:team", () => {
    expect(ownerEntityId("@org/platform")).toBe("team:platform");
  });
  test("@login → person:login", () => {
    expect(ownerEntityId("@octocat")).toBe("person:octocat");
  });
  test("email → person:email", () => {
    expect(ownerEntityId("dev@example.com")).toBe("person:dev@example.com");
  });
});
