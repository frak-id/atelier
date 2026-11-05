import { describe, expect, test } from "bun:test";
import {
  decideForwardAuth,
  decideWake,
  type ForwardedRequest,
  forwardedUrl,
  isReturnUrl,
  sandboxIdFromHost,
  wakePage,
} from "./forward-auth.ts";

const BASE = "hetzner-staging.frak.id";
const LOGIN = `https://atelier.${BASE}/auth/github`;

const page: ForwardedRequest = {
  proto: "https",
  host: `pi-web-abc123.${BASE}`,
  uri: "/session/1?x=y",
  method: "GET",
  accept: "text/html,application/xhtml+xml",
};

const decide = (signedIn: boolean, forwarded = page) =>
  decideForwardAuth({
    signedIn,
    forwarded,
    loginUrl: LOGIN,
    baseDomain: BASE,
    allowHttp: false,
  });

describe("decideForwardAuth", () => {
  test("a signed-in caller goes through", () => {
    expect(decide(true)).toEqual({ status: 200 });
    expect(decide(true, { ...page, accept: "*/*", method: "POST" })).toEqual({
      status: 200,
    });
  });

  test("a browser page load without a session goes to the login and back", () => {
    expect(decide(false)).toEqual({
      status: 302,
      location: `${LOGIN}?return_to=${encodeURIComponent(
        `https://pi-web-abc123.${BASE}/session/1?x=y`,
      )}`,
    });
  });

  test("API calls, websockets and assets without a session get 401", () => {
    expect(decide(false, { ...page, accept: "application/json" })).toEqual({
      status: 401,
    });
    expect(decide(false, { ...page, method: "POST" })).toEqual({
      status: 401,
    });
    expect(decide(false, { ...page, accept: undefined })).toEqual({
      status: 401,
    });
  });

  test("never builds a login redirect back to a foreign host", () => {
    expect(decide(false, { ...page, host: "evil.example" })).toEqual({
      status: 401,
    });
  });
});

describe("isReturnUrl", () => {
  test("accepts the base domain and its subdomains over https", () => {
    expect(isReturnUrl(`https://pi-web-x.${BASE}/a`, BASE, false)).toBe(true);
    expect(isReturnUrl(`https://${BASE}/`, BASE, false)).toBe(true);
  });

  test("rejects other hosts, look-alikes, http in production and credentials", () => {
    expect(isReturnUrl("https://evil.example/", BASE, false)).toBe(false);
    expect(isReturnUrl(`https://evil${BASE}/`, BASE, false)).toBe(false);
    expect(isReturnUrl(`https://${BASE}.evil.example/`, BASE, false)).toBe(
      false,
    );
    expect(isReturnUrl(`http://x.${BASE}/`, BASE, false)).toBe(false);
    expect(isReturnUrl(`http://x.${BASE}/`, BASE, true)).toBe(true);
    expect(isReturnUrl(`https://u:p@x.${BASE}/`, BASE, false)).toBe(false);
    expect(isReturnUrl("javascript:alert(1)", BASE, true)).toBe(false);
    expect(isReturnUrl("not a url", BASE, true)).toBe(false);
  });
});

describe("forwardedUrl", () => {
  test("rebuilds the original URL, https unless told http", () => {
    expect(forwardedUrl({ host: "a.b", uri: "/x" })).toBe("https://a.b/x");
    expect(forwardedUrl({ proto: "http", host: "a.b" })).toBe("http://a.b/");
    expect(forwardedUrl({ host: "a.b", uri: "//evil.example" })).toBe(
      "https://a.b//evil.example",
    );
    expect(forwardedUrl({})).toBeUndefined();
  });
});

describe("sandboxIdFromHost", () => {
  test("reads the id off a tool host", () => {
    expect(sandboxIdFromHost(`pi-web-abc123def456.${BASE}`, BASE)).toBe(
      "abc123def456",
    );
    expect(sandboxIdFromHost(`web-abc123def456.${BASE}:8443`, BASE)).toBe(
      "abc123def456",
    );
    expect(sandboxIdFromHost(`WEB-ABC123.${BASE.toUpperCase()}`, BASE)).toBe(
      "abc123",
    );
  });

  test("anything else is not a tool host", () => {
    expect(sandboxIdFromHost(undefined, BASE)).toBeUndefined();
    expect(sandboxIdFromHost(`atelier.${BASE}`, BASE)).toBeUndefined();
    expect(sandboxIdFromHost(`a-b.c.${BASE}`, BASE)).toBeUndefined();
    expect(sandboxIdFromHost("web-abc123.example.com", BASE)).toBeUndefined();
    expect(sandboxIdFromHost(BASE, BASE)).toBeUndefined();
    expect(sandboxIdFromHost(`web-.${BASE}`, BASE)).toBeUndefined();
  });
});

describe("decideWake", () => {
  test("only a paused sandbox wakes", () => {
    for (const status of [
      "running",
      "creating",
      "error",
      "stopped",
      undefined,
    ]) {
      expect(decideWake(status, page)).toEqual({ status: 200 });
    }
    expect(decideWake("paused", page).status).toBe(503);
  });

  test("a browser page load gets the refreshing page", () => {
    expect(decideWake("paused", page)).toEqual({ status: 503, page: true });
  });

  test("API calls, assets and non-GET requests get a bare 503", () => {
    expect(
      decideWake("paused", { ...page, accept: "application/json" }),
    ).toEqual({ status: 503, page: false });
    expect(decideWake("paused", { ...page, method: "POST" })).toEqual({
      status: 503,
      page: false,
    });
    expect(decideWake("paused", { host: page.host })).toEqual({
      status: 503,
      page: false,
    });
  });

  test("the page reloads itself", () => {
    expect(wakePage()).toContain('http-equiv="refresh"');
    expect(wakePage()).toContain("Waking up sandbox");
  });
});
