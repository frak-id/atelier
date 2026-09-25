import { describe, expect, test } from "bun:test";
import {
  AuthError,
  mintToken,
  requireScope,
  resolveAudience,
  TokenAuth,
} from "./auth.ts";

const minted = mintToken();
const auth = new TokenAuth([
  {
    name: "gateway",
    sha256: minted.sha256,
    actor: { kind: "agent", id: "agent:slack" },
    scopes: ["read", "propose"],
    audience: ["org"],
    mayAddress: ["org", "channel:C1"],
  },
]);

describe("TokenAuth", () => {
  test("resolves a token, with or without the Bearer prefix", () => {
    expect(auth.authenticate(`Bearer ${minted.token}`).actor.id).toBe(
      "agent:slack",
    );
    expect(auth.authenticate(minted.token).token).toBe("gateway");
  });

  test("rejects missing and unknown tokens with 401", () => {
    for (const header of [null, "", "Bearer hub_wrong"]) {
      try {
        auth.authenticate(header);
        throw new Error("expected AuthError");
      } catch (error) {
        expect(error).toBeInstanceOf(AuthError);
        expect((error as AuthError).status).toBe(401);
      }
    }
  });

  test("scopes gate operations with 403", () => {
    const caller = auth.authenticate(minted.token);
    expect(() => requireScope(caller, "read")).not.toThrow();
    expect(() => requireScope(caller, "review")).toThrow(AuthError);
  });

  test("a request may only address principals the token allows", () => {
    const caller = auth.authenticate(minted.token);
    expect(resolveAudience(caller)).toEqual(["org"]);
    expect(resolveAudience(caller, "channel:C1")).toEqual(["channel:C1"]);
    expect(() => resolveAudience(caller, ["user:ceo"])).toThrow(/may not/);
  });
});
