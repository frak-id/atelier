import { describe, expect, test } from "bun:test";
import type { SandboxSpec } from "@atelier/spec";
import { injectDevServerHosts, VITE_ALLOWED_HOSTS_ENV } from "./enrichment.ts";

const spec: SandboxSpec = {
  source: { image: "dev-base" },
  resources: { vcpus: 2, memoryMb: 4096 },
};

describe("injectDevServerHosts", () => {
  test("allows the sandbox domain and its subdomains", () => {
    const out = injectDevServerHosts(
      { ...spec, env: { NODE_ENV: "development" } },
      "hetzner-staging.frak.id",
    );
    expect(out.env).toEqual({
      NODE_ENV: "development",
      [VITE_ALLOWED_HOSTS_ENV]: ".hetzner-staging.frak.id",
    });
  });

  test("normalizes the configured domain", () => {
    const out = injectDevServerHosts(spec, " Sandboxes.Example.com:8443 ");
    expect(out.env?.[VITE_ALLOWED_HOSTS_ENV]).toBe(".sandboxes.example.com");
  });

  test("skips localhost domains, already allowed by Vite", () => {
    expect(injectDevServerHosts(spec, "localhost")).toBe(spec);
    expect(injectDevServerHosts(spec, "atelier.localhost")).toBe(spec);
    expect(injectDevServerHosts(spec, "")).toBe(spec);
  });

  test("the spec's own value wins", () => {
    const own = { ...spec, env: { [VITE_ALLOWED_HOSTS_ENV]: "my.host" } };
    expect(injectDevServerHosts(own, "example.com")).toBe(own);
  });
});
