import { beforeAll, describe, expect, test } from "bun:test";
import { opencodeHarness, registerHarness } from "@atelier/compose";
import type { SandboxSpec } from "@atelier/spec";
import {
  GIT_CREDENTIALS_PATH,
  OWNER_ID_METADATA,
} from "../shared/lib/git-attribution.ts";
import {
  type EnrichmentDeps,
  enrichSpec,
  injectDevServerHosts,
  VITE_ALLOWED_HOSTS_ENV,
} from "./enrichment.ts";

const ORG = "org-1";

/** An org whose policy mandates a compliance file and defaults to opencode. */
const deps = {
  secrets: { resolve: async () => "resolved" },
  orgPolicy: {
    getByOrgId: (orgId: string) =>
      orgId === ORG
        ? {
            orgId,
            fragment: {
              harness: "opencode",
              files: [{ path: "/etc/compliance", content: "on" }],
            },
          }
        : undefined,
  },
} as unknown as EnrichmentDeps;

const owner = {
  id: "user-1",
  username: "alice",
  email: "alice@example.com",
  githubToken: "gho_token",
};

const spec: SandboxSpec = {
  source: { image: "dev-base" },
  resources: { vcpus: 1, memoryMb: 1024 },
  env: { API_KEY: { $secret: "api-key" } },
};

const paths = (s: SandboxSpec) => (s.files ?? []).map((f) => f.path);

beforeAll(() => registerHarness(opencodeHarness));

describe("enrichSpec", () => {
  test("personalized: org default harness and owner git attribution", async () => {
    const out = await enrichSpec(spec, ORG, deps, { owner });

    expect(out.processes?.map((p) => p.name)).toContain("acp");
    expect(paths(out)).toContain(GIT_CREDENTIALS_PATH);
    expect(out.metadata?.[OWNER_ID_METADATA]).toBe(owner.id);
  });

  test("unpersonalized: no default harness, no git credentials", async () => {
    const out = await enrichSpec(spec, ORG, deps, { personalize: false });

    expect(out.processes ?? []).toEqual([]);
    expect(paths(out)).not.toContain(GIT_CREDENTIALS_PATH);
    expect(out.metadata?.[OWNER_ID_METADATA]).toBeUndefined();
  });

  test("unpersonalized: org policy and secret resolution still apply", async () => {
    const out = await enrichSpec(spec, ORG, deps, { personalize: false });

    expect(paths(out)).toContain("/etc/compliance");
    expect(out.env?.API_KEY).toBe("resolved");
  });

  test("unpersonalized: an explicitly selected toolbox harness still wins", async () => {
    const out = await enrichSpec(spec, ORG, deps, {
      personalize: false,
      toolboxHarnessId: "opencode",
    });

    expect(out.processes?.map((p) => p.name)).toContain("acp");
  });
});

const devSpec: SandboxSpec = {
  source: { image: "dev-base" },
  resources: { vcpus: 2, memoryMb: 4096 },
};

describe("injectDevServerHosts", () => {
  test("allows the sandbox domain and its subdomains", () => {
    const out = injectDevServerHosts(
      { ...devSpec, env: { NODE_ENV: "development" } },
      "hetzner-staging.frak.id",
    );
    expect(out.env).toEqual({
      NODE_ENV: "development",
      [VITE_ALLOWED_HOSTS_ENV]: ".hetzner-staging.frak.id",
    });
  });

  test("normalizes the configured domain", () => {
    const out = injectDevServerHosts(devSpec, " Sandboxes.Example.com:8443 ");
    expect(out.env?.[VITE_ALLOWED_HOSTS_ENV]).toBe(".sandboxes.example.com");
  });

  test("skips localhost domains, already allowed by Vite", () => {
    expect(injectDevServerHosts(devSpec, "localhost")).toBe(devSpec);
    expect(injectDevServerHosts(devSpec, "atelier.localhost")).toBe(devSpec);
    expect(injectDevServerHosts(devSpec, "")).toBe(devSpec);
  });

  test("the spec's own value wins", () => {
    const own = { ...devSpec, env: { [VITE_ALLOWED_HOSTS_ENV]: "my.host" } };
    expect(injectDevServerHosts(own, "example.com")).toBe(own);
  });
});
