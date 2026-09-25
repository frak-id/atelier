import { describe, expect, test } from "bun:test";
import {
  signPayload,
  triageDelivery,
  verifySignature,
} from "./github-webhook.ts";

const repos = [{ repo: "frak-id/atelier", branch: "main" }];

describe("verifySignature", () => {
  test("accepts GitHub's sha256 HMAC and nothing else", () => {
    const body = '{"a":1}';
    const sig = signPayload("secret", body);
    expect(verifySignature("secret", body, sig)).toBe(true);
    expect(verifySignature("other", body, sig)).toBe(false);
    expect(verifySignature("secret", `${body} `, sig)).toBe(false);
    expect(verifySignature("secret", body, null)).toBe(false);
    expect(verifySignature("secret", body, "sha256=short")).toBe(false);
  });
});

describe("triageDelivery", () => {
  const push = (ref: string, extra: object = {}) => ({
    ref,
    after: "abc",
    repository: { full_name: "Frak-Id/Atelier" },
    ...extra,
  });

  test("a push to the tracked branch re-indexes", () => {
    expect(triageDelivery("push", push("refs/heads/main"), repos)).toEqual({
      action: "index",
      repo: repos[0] as (typeof repos)[0],
      revision: "abc",
    });
  });

  test("everything else is ignored", () => {
    expect(triageDelivery("ping", {}, repos).action).toBe("ignore");
    expect(triageDelivery("issues", {}, repos).action).toBe("ignore");
    expect(
      triageDelivery("push", push("refs/heads/feature"), repos).action,
    ).toBe("ignore");
    expect(
      triageDelivery("push", push("refs/heads/main", { deleted: true }), repos)
        .action,
    ).toBe("ignore");
    expect(
      triageDelivery(
        "push",
        { ref: "refs/heads/main", repository: { full_name: "x/y" } },
        repos,
      ).action,
    ).toBe("ignore");
  });
});
