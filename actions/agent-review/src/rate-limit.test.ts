import { describe, expect, test } from "bun:test";
import { rateLimitWait } from "./rate-limit.ts";

const response = (status: number, headers: Record<string, string> = {}) => ({
  status,
  headers: new Headers(headers),
});

describe("a rate limit", () => {
  test("waits what retry-after says", () => {
    expect(rateLimitWait(response(429, { "retry-after": "30" }), "")).toBe(
      30_000,
    );
    expect(
      rateLimitWait(
        response(403, { "retry-after": "7" }),
        "You have exceeded a secondary rate limit",
      ),
    ).toBe(7_000);
  });

  test("waits for the primary limit's reset, and a second more", () => {
    const now = 1_700_000_000_000;
    expect(
      rateLimitWait(
        response(403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(now / 1000 + 90),
        }),
        "API rate limit exceeded",
        now,
      ),
    ).toBe(91_000);
  });

  test("waits a minute for a secondary limit that says nothing more", () => {
    expect(
      rateLimitWait(
        response(403),
        '{"message":"You have exceeded a secondary rate limit."}',
      ),
    ).toBe(60_000);
  });

  test("is no other refusal: a permission, a validation, a server error", () => {
    expect(
      rateLimitWait(
        response(403, { "x-ratelimit-remaining": "4999" }),
        '{"message":"Resource not accessible by integration"}',
      ),
    ).toBeUndefined();
    expect(
      rateLimitWait(response(422, { "retry-after": "5" }), ""),
    ).toBeUndefined();
    expect(rateLimitWait(response(502), "rate limit")).toBeUndefined();
  });
});
