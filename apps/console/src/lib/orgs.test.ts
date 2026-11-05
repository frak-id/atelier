import { describe, expect, test } from "bun:test";
import { ownerScopes, pickDefaultOrgId } from "./orgs.ts";

describe("ownerScopes", () => {
  const orgs = [
    { id: "acme", name: "Acme", role: "member" as const },
    { id: "me", name: "quentin", role: "owner" as const, mine: true },
    { id: "frak", name: "Frak", role: "owner" as const, default: true },
  ];

  test("personal org first, then the rest in server order", () => {
    expect(ownerScopes(orgs).map((s) => s.owner)).toEqual([
      "org:me",
      "org:acme",
      "org:frak",
    ]);
  });

  test("only owners are flagged as owner; the default org is flagged", () => {
    const byOrg = Object.fromEntries(
      ownerScopes(orgs).map((s) => [s.orgId, s]),
    );
    expect(byOrg.me?.isOwner).toBe(true);
    expect(byOrg.acme?.isOwner).toBe(false);
    expect(byOrg.frak?.isDefault).toBe(true);
    expect(byOrg.me?.isDefault).toBe(false);
  });
});

describe("pickDefaultOrgId", () => {
  test("team org, then personal org, then the first one", () => {
    const orgs = [
      { id: "acme" },
      { id: "me", mine: true },
      { id: "frak", default: true },
    ];
    expect(pickDefaultOrgId(orgs)).toBe("frak");
    expect(pickDefaultOrgId(orgs.filter((o) => o.id !== "frak"))).toBe("me");
    expect(pickDefaultOrgId([{ id: "acme" }])).toBe("acme");
    expect(pickDefaultOrgId([])).toBe("");
  });
});
