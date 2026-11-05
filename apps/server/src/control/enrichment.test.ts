import { describe, expect, test } from "bun:test";
import type { SandboxSpec } from "@atelier/spec";
import {
  buildGitAttributionFiles,
  GIT_CREDENTIALS_PATH,
  OWNER_ANNOTATION,
  OWNER_EMAIL_ANNOTATION,
  OWNER_ID_METADATA,
} from "../shared/lib/git-attribution.ts";
import {
  enrichSpec,
  injectDevServerHosts,
  reattributeSpec,
  resolveBootSpec,
  VITE_ALLOWED_HOSTS_ENV,
} from "./enrichment.ts";

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

describe("reattributeSpec", () => {
  const alice = { id: "u-alice", username: "alice", email: "alice@x.test" };
  const bob = { id: "u-bob", username: "bob", email: "bob@x.test" };
  // A stored spec as `enrichSpec` leaves it for alice: refs, no credentials.
  const stored: SandboxSpec = {
    ...spec,
    env: { KEY: { $secret: "KEY" } },
    files: [{ path: "/home/dev/keep.txt", content: "keep" }],
    annotations: {
      [OWNER_ANNOTATION]: "alice",
      [OWNER_EMAIL_ANNOTATION]: alice.email,
      "atelier.dev/org-id": "org-1",
    },
    metadata: { [OWNER_ID_METADATA]: alice.id, steery: "host" },
  };

  test("carries the caller's attribution and none of the source owner's", () => {
    const out = reattributeSpec(stored, bob, {
      [OWNER_ID_METADATA]: alice.id, // an echoed owner-id is overridden
      steery: "copy",
    });
    expect(JSON.stringify(out)).not.toContain("alice");
    expect(out.annotations).toEqual({
      [OWNER_ANNOTATION]: "bob",
      [OWNER_EMAIL_ANNOTATION]: bob.email,
      "atelier.dev/org-id": "org-1", // the copy stays in the source's org
    });
    expect(out.metadata).toEqual({
      [OWNER_ID_METADATA]: bob.id,
      steery: "copy",
    });
    // Refs stay refs; nothing is resolved or injected on the stored spec.
    expect(out.env).toEqual({ KEY: { $secret: "KEY" } });
    expect(out.files).toEqual(stored.files);
  });

  test("the source's metadata does not carry over", () => {
    expect(reattributeSpec(stored, bob).metadata).toEqual({
      [OWNER_ID_METADATA]: bob.id,
    });
  });

  test("git files stored by an older version are dropped", () => {
    const legacy: SandboxSpec = {
      ...stored,
      files: [
        ...(stored.files ?? []),
        ...buildGitAttributionFiles({
          identity: { name: "alice", email: alice.email },
          githubToken: "ghp_alice",
        }),
      ],
    };
    const out = reattributeSpec(legacy, bob);
    expect(JSON.stringify(out)).not.toContain("ghp_alice");
    expect(out.files).toEqual(stored.files);
  });
});

describe("enrichSpec", () => {
  test("keeps $secret refs and writes no credential file", () => {
    const out = enrichSpec(
      { ...spec, env: { KEY: { $secret: "KEY" } } },
      { owner: { id: "u1", username: "alice", email: "alice@x.test" } },
    );
    expect(out.env?.KEY).toEqual({ $secret: "KEY" });
    expect(out.files).toBeUndefined();
    expect(out.metadata?.[OWNER_ID_METADATA]).toBe("u1");
    expect(out.annotations?.[OWNER_ANNOTATION]).toBe("alice");
  });
});

describe("resolveBootSpec", () => {
  const users = (token: string | undefined) => ({
    getById: (id: string) =>
      id === "u1"
        ? ({ username: "alice", email: "alice@x.test" } as never)
        : undefined,
    resolveGitHubToken: () => token,
  });
  const secrets = {
    resolve: async (orgId: string | undefined, name: string) =>
      `${orgId}:${name}`,
  } as never;
  const stored: SandboxSpec = {
    ...spec,
    env: { KEY: { $secret: "KEY" }, PLAIN: "v" },
    files: [{ path: "/etc/key", content: { $secret: "FILE" } }],
    processes: [
      { name: "p", command: "c", env: { TOKEN: { $secret: "TOKEN" } } },
    ],
    annotations: { "atelier.dev/org-id": "org-1" },
    metadata: { [OWNER_ID_METADATA]: "u1" },
  };

  test("resolves secrets in the sandbox's org, and adds the owner's git files", async () => {
    const out = await resolveBootSpec(stored, {
      secrets,
      users: users("ghp_now"),
    });
    expect(out.env).toEqual({ KEY: "org-1:KEY", PLAIN: "v" });
    expect(out.files?.find((f) => f.path === "/etc/key")?.content).toBe(
      "org-1:FILE",
    );
    expect(out.processes?.[0]?.env).toEqual({ TOKEN: "org-1:TOKEN" });
    const creds = out.files?.find((f) => f.path === GIT_CREDENTIALS_PATH);
    expect(creds?.content).toContain("ghp_now");
    // The stored spec is untouched.
    expect(JSON.stringify(stored)).not.toContain("org-1:KEY");
    expect(JSON.stringify(stored)).not.toContain("ghp_now");
  });

  test("a rotated token replaces the one an older spec stored", async () => {
    const withOld: SandboxSpec = {
      ...stored,
      files: [
        ...(stored.files ?? []),
        ...buildGitAttributionFiles({ githubToken: "ghp_old" }),
      ],
    };
    const out = await resolveBootSpec(withOld, {
      secrets,
      users: users("ghp_new"),
    });
    expect(JSON.stringify(out)).not.toContain("ghp_old");
    expect(
      out.files?.filter((f) => f.path === GIT_CREDENTIALS_PATH),
    ).toHaveLength(1);
  });

  test("no token and no owner mean no credential file", async () => {
    const noToken = await resolveBootSpec(stored, {
      secrets,
      users: users(undefined),
    });
    expect(noToken.files?.some((f) => f.path === GIT_CREDENTIALS_PATH)).toBe(
      false,
    );
    const { metadata: _m, ...ownerless } = stored;
    const out = await resolveBootSpec(ownerless, {
      secrets,
      users: users("ghp_x"),
    });
    expect(JSON.stringify(out)).not.toContain("ghp_x");
  });
});
