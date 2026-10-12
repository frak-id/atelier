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
  injectDevServerHosts,
  reattributeSpec,
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
  const alice = {
    id: "u-alice",
    username: "alice",
    email: "alice@example.test",
    githubToken: "ghp_alice",
  };
  const bob = {
    id: "u-bob",
    username: "bob",
    email: "bob@example.test",
    githubToken: "ghp_bob",
  };
  // A stored, enriched spec as `createSandboxForUser` leaves it for alice.
  const stored: SandboxSpec = {
    ...spec,
    files: [
      { path: "/home/dev/keep.txt", content: "keep" },
      ...buildGitAttributionFiles({
        identity: { name: alice.username, email: alice.email },
        githubToken: alice.githubToken,
      }),
    ],
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
    const dump = JSON.stringify(out);
    expect(dump).not.toContain("ghp_alice");
    expect(dump).not.toContain("alice@example.test");
    expect(out.annotations?.[OWNER_ANNOTATION]).toBe("bob");

    const creds = out.files?.filter((f) => f.path === GIT_CREDENTIALS_PATH);
    expect(creds).toHaveLength(1);
    expect(creds?.[0]?.content).toContain("ghp_bob");
    const gitconfigs = out.files?.filter((f) => f.path === "/etc/gitconfig");
    expect(gitconfigs).toHaveLength(1);
    expect(gitconfigs?.[0]?.content).toContain("bob@example.test");

    expect(out.annotations).toEqual({
      [OWNER_ANNOTATION]: "bob",
      [OWNER_EMAIL_ANNOTATION]: bob.email,
      "atelier.dev/org-id": "org-1", // the copy stays in the source's org
    });
    expect(out.metadata).toEqual({
      [OWNER_ID_METADATA]: bob.id,
      steery: "copy",
    });
    expect(out.files?.some((f) => f.path === "/home/dev/keep.txt")).toBe(true);
  });

  test("the source's metadata does not carry over", () => {
    expect(reattributeSpec(stored, bob).metadata).toEqual({
      [OWNER_ID_METADATA]: bob.id,
    });
  });

  test("a caller without a token leaves no credential file behind", () => {
    const out = reattributeSpec(stored, { ...bob, githubToken: undefined });
    expect(out.files?.some((f) => f.path === GIT_CREDENTIALS_PATH)).toBe(false);
  });
});
