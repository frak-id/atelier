import { describe, expect, test } from "bun:test";
import {
  createBody,
  emptyForm,
  formFromAccount,
  githubSummaryText,
  parsePermissions,
  parseRepositories,
  updateBody,
  validateForm,
} from "./service-accounts.ts";

describe("parseRepositories", () => {
  test("splits on commas and whitespace, dedupes", () => {
    expect(parseRepositories("api, web\nweb  docs,")).toEqual([
      "api",
      "web",
      "docs",
    ]);
    expect(parseRepositories("  ")).toEqual([]);
  });
});

describe("parsePermissions", () => {
  test("accepts name:level and name=level", () => {
    expect(parsePermissions("contents:write, pull_requests=read")).toEqual({
      ok: true,
      permissions: { contents: "write", pull_requests: "read" },
    });
  });
  test("reports the bad token", () => {
    expect(parsePermissions("contents:admin")).toEqual({
      ok: false,
      invalid: "contents:admin",
    });
  });
});

describe("githubSummaryText", () => {
  test("one line per kind", () => {
    expect(githubSummaryText({ kind: "none" })).toBe("No GitHub credential");
    expect(
      githubSummaryText({
        kind: "app",
        appId: "123456",
        installationId: "789",
      }),
    ).toBe("GitHub App 123456 / installation 789");
    expect(
      githubSummaryText({ kind: "token", gitName: "Bot", gitEmail: "b@x.io" }),
    ).toBe("Static token as Bot");
  });
});

describe("createBody", () => {
  test("minimal body omits empty optionals", () => {
    const form = { ...emptyForm("org1"), name: " daedalus " };
    expect(createBody(form)).toEqual({
      name: "daedalus",
      orgId: "org1",
      role: "member",
    });
  });
  test("app credential", () => {
    const form = {
      ...emptyForm("org1"),
      name: "a",
      githubChoice: "app" as const,
      appId: "1",
      installationId: "2",
      privateKey: "PEM",
      repositories: "api web",
      permissions: "contents:write",
    };
    expect(createBody(form).github).toEqual({
      kind: "app",
      appId: "1",
      installationId: "2",
      privateKey: "PEM",
      repositories: ["api", "web"],
      permissions: { contents: "write" },
    });
  });
});

describe("createBody token kind", () => {
  test("trims the token and git identity", () => {
    const form = {
      ...emptyForm("org1"),
      name: "a",
      githubChoice: "token" as const,
      token: " ghp_x ",
      gitName: " Bot ",
      gitEmail: " b@x.io ",
    };
    expect(createBody(form).github).toEqual({
      kind: "token",
      token: "ghp_x",
      gitName: "Bot",
      gitEmail: "b@x.io",
    });
  });
});

describe("updateBody", () => {
  const stored = {
    name: "a",
    description: "d",
    orgId: "o",
    role: "member" as const,
    github: { kind: "app" as const, appId: "1", installationId: "2" },
  };
  test("unchanged kind keeps the secret: none is sent", () => {
    const body = updateBody(formFromAccount(stored));
    expect(body.github).toEqual({
      kind: "app",
      appId: "1",
      installationId: "2",
    });
    expect(validateForm(formFromAccount(stored), "app")).toBeNull();
  });
  test("remove sends null", () => {
    const form = {
      ...formFromAccount(stored),
      githubChoice: "remove" as const,
    };
    expect(updateBody(form).github).toBeNull();
  });
  test("no credential and none chosen leaves github out", () => {
    const form = formFromAccount({ ...stored, github: { kind: "none" } });
    expect("github" in updateBody(form)).toBe(false);
  });
  test("token edit with the token omitted sends no token key", () => {
    const form = formFromAccount({
      ...stored,
      github: { kind: "token", gitName: "Bot", gitEmail: "b@x.io" },
    });
    const github = updateBody(form).github;
    expect(github).toEqual({
      kind: "token",
      gitName: "Bot",
      gitEmail: "b@x.io",
    });
    expect(github && "token" in github).toBe(false);
    expect(validateForm(form, "token")).toBeNull();
  });
  test("whitespace-only private key is omitted on edit", () => {
    const form = { ...formFromAccount(stored), privateKey: "  \n " };
    const github = updateBody(form).github;
    expect(github && "privateKey" in github).toBe(false);
  });
  test("switching kind requires the new secret", () => {
    const form = {
      ...formFromAccount(stored),
      githubChoice: "token" as const,
      gitName: "n",
      gitEmail: "e",
    };
    expect(validateForm(form, "app")).toBe("The token is required");
  });
});

describe("validateForm", () => {
  test("requires an organization", () => {
    expect(validateForm({ ...emptyForm(), name: "a" })).toBe(
      "Pick an organization",
    );
  });
});
