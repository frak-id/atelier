import { describe, expect, test } from "bun:test";
import { ownerScopes } from "./orgs.ts";

describe("ownerScopes", () => {
  const orgs = [
    { id: "acme", name: "Acme", role: "member" as const },
    { id: "me", name: "quentin", role: "owner" as const, mine: true },
    { id: "frak", name: "Frak", role: "admin" as const, mine: false },
  ];

  test("personal org first, then the rest in server order", () => {
    expect(
      ownerScopes(orgs, { includeUser: false }).map((s) => s.owner),
    ).toEqual(["org:me", "org:acme", "org:frak"]);
  });

  test("the caller's own scope leads when the record type has one", () => {
    const [user, personal] = ownerScopes(orgs, { includeUser: true });
    expect(user).toEqual({
      owner: "user",
      label: "Personal",
      mine: true,
      canManage: true,
    });
    expect(personal?.owner).toBe("org:me");
  });

  test("only owners and admins manage an org scope", () => {
    const manage = Object.fromEntries(
      ownerScopes(orgs, { includeUser: false }).map((s) => [
        s.orgId,
        s.canManage,
      ]),
    );
    expect(manage).toEqual({ me: true, acme: false, frak: true });
  });
});
