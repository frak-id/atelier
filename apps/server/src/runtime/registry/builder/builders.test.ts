/**
 * Unit coverage for the cluster-native builders' PURE pieces — arg/manifest
 * construction, context packaging, and digest read-back. The Job I/O itself
 * (submit/watch/stream) needs a real cluster and is exercised there; these
 * lock the parts that must stay correct regardless.
 */

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ATELIER_SERVER_MODE = "mock";

const { kanikoArgs } = await import("./kaniko.builder.ts");
const { buildctlArgs } = await import("./buildkit.builder.ts");
const {
  buildJobManifest,
  extractDigest,
  jobResourceName,
  stageContextTarball,
} = await import("./k8s-build-job.ts");
const { formatBuildArgs, shQuote } = await import("./builder.types.ts");
const { DockerImageBuilder } = await import("./docker.builder.ts");
const { ImageBuilderService } = await import("../image-builder.service.ts");
const { InMemoryImageStore } = await import("../../store.ts");
const { ValidationError } = await import("../../../shared/errors.ts");

const baseReq = {
  contextDir: "/tmp/ctx",
  dockerfile: "FROM scratch",
  tag: "zot.atelier-system.svc:5000/dev-base:latest",
  insecureRegistry: true,
} as const;

describe("kanikoArgs", () => {
  test("targets the unpacked workspace and writes the digest file", () => {
    const args = kanikoArgs(baseReq);
    expect(args).toContain("--context=dir:///workspace");
    expect(args).toContain("--dockerfile=/workspace/Dockerfile");
    expect(args).toContain(`--destination=${baseReq.tag}`);
    expect(args).toContain("--digest-file=/dev/termination-log");
  });

  test("insecure registry adds the skip-tls flags", () => {
    expect(kanikoArgs(baseReq)).toContain("--skip-tls-verify");
    const secure = kanikoArgs({ ...baseReq, insecureRegistry: false });
    expect(secure).not.toContain("--skip-tls-verify");
  });

  test("cacheRepo enables caching", () => {
    const args = kanikoArgs({ ...baseReq, cacheRepo: "reg/cache" });
    expect(args).toContain("--cache=true");
    expect(args).toContain("--cache-repo=reg/cache");
  });
});

describe("buildctlArgs", () => {
  const tls = { secretName: "", serverName: "" };

  test("builds against the workspace and pushes to the tag", () => {
    const args = buildctlArgs(baseReq, "tcp://buildkitd:1234", tls).join(" ");
    expect(args).toContain("--addr tcp://buildkitd:1234");
    expect(args).toContain("--local context=/workspace");
    expect(args).toContain(`type=image,name=${baseReq.tag},push=true`);
    expect(args).toContain("registry.insecure=true");
    // Zot rejects buildx's default manifest index without these two.
    expect(args).toContain("oci-mediatypes=true,image-manifest=true");
    expect(args).toContain("--metadata-file /tmp/atelier-md.json");
  });

  test("mTLS mounts the client cert flags", () => {
    const args = buildctlArgs(baseReq, "tcp://d:1", {
      secretName: "bk-tls",
      serverName: "buildkitd",
    }).join(" ");
    expect(args).toContain("--tlscacert /certs/ca.crt");
    expect(args).toContain("--tlsservername buildkitd");
  });
});

describe("jobResourceName", () => {
  test("derives a DNS-1123 stem from the tag", () => {
    const name = jobResourceName("reg:5000/dev-base@sha256:abc");
    expect(name).toMatch(/^atelier-build-dev-base-[a-z0-9]{6}$/);
  });
});

describe("extractDigest", () => {
  test("reads the digest from the build container's terminated message", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(
      extractDigest({
        status: {
          containerStatuses: [
            {
              name: "build",
              state: { terminated: { message: `${digest}\n` } },
            },
          ],
        },
      }),
    ).toBe(digest);
  });

  test("undefined when no digest present", () => {
    expect(
      extractDigest({
        status: { containerStatuses: [{ name: "build", state: {} }] },
      }),
    ).toBeUndefined();
  });
});

describe("buildJobManifest", () => {
  test("wires the context ConfigMap, unpack init, and build container", () => {
    const manifest = buildJobManifest(
      {
        name: "atelier-build-dev-base-abc123",
        contextDir: "/tmp/ctx",
        dockerfile: "FROM scratch",
        container: { image: "kaniko:latest", args: ["--destination=x"] },
      },
      "atelier-build-dev-base-abc123-ctx",
    ) as {
      spec: {
        template: {
          spec: {
            restartPolicy: string;
            initContainers: { name: string }[];
            containers: {
              name: string;
              image: string;
              terminationMessagePolicy: string;
            }[];
            volumes: { configMap?: { name: string } }[];
          };
        };
      };
    };

    const podSpec = manifest.spec.template.spec;
    expect(podSpec.restartPolicy).toBe("Never");
    expect(podSpec.initContainers[0]?.name).toBe("unpack");
    expect(podSpec.containers[0]?.name).toBe("build");
    expect(podSpec.containers[0]?.image).toBe("kaniko:latest");
    expect(podSpec.containers[0]?.terminationMessagePolicy).toBe("File");
    expect(podSpec.volumes[0]?.configMap?.name).toBe(
      "atelier-build-dev-base-abc123-ctx",
    );
  });
});

describe("stageContextTarball", () => {
  test("packages the context with the rewritten Dockerfile as base64 gz", async () => {
    const tmp = `${process.env.TMPDIR ?? "/tmp"}/atelier-test-ctx-${Date.now()}`;
    await Bun.write(`${tmp}/existing.txt`, "hello");
    const encoded = await stageContextTarball(tmp, "FROM alpine\n");
    // Valid base64 that decodes to a gzip stream (magic bytes 1f 8b).
    const bytes = Buffer.from(encoded, "base64");
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(encoded.length).toBeGreaterThan(0);
  });
});

// ── H2: shared buildArgs formatting helper ──────────────────────────────────

describe("formatBuildArgs", () => {
  test("applies the caller's flag formatter to every key/value pair", () => {
    const out = formatBuildArgs({ FOO: "1", BAR: "2" }, (k, v) => [
      "--opt",
      `build-arg:${k}=${v}`,
    ]);
    expect(out).toEqual([
      "--opt",
      "build-arg:FOO=1",
      "--opt",
      "build-arg:BAR=2",
    ]);
  });

  test("empty for undefined/empty buildArgs", () => {
    expect(formatBuildArgs(undefined, (k, v) => [`${k}=${v}`])).toEqual([]);
    expect(formatBuildArgs({}, (k, v) => [`${k}=${v}`])).toEqual([]);
  });

  test("kanikoArgs and buildctlArgs both route through it (one shared loop)", () => {
    const buildArgs = { TOKEN: "abc", VERSION: "1.2.3" };
    const kaniko = kanikoArgs({ ...baseReq, buildArgs });
    expect(kaniko).toContain("--build-arg=TOKEN=abc");
    expect(kaniko).toContain("--build-arg=VERSION=1.2.3");

    const buildkit = buildctlArgs(
      { ...baseReq, buildArgs },
      "tcp://buildkitd:1234",
      { secretName: "", serverName: "" },
    );
    expect(buildkit).toContain("--opt");
    expect(buildkit).toContain("build-arg:TOKEN=abc");
    expect(buildkit).toContain("build-arg:VERSION=1.2.3");
  });
});

// ── H1: buildkit's sh -c script must shell-quote every interpolated value ──

describe("shQuote", () => {
  test("round-trips arbitrary values through a real POSIX shell unmodified", async () => {
    const dangerous = [
      "plain",
      "has spaces",
      "it's got a quote",
      "$(touch /tmp/atelier-shquote-pwned)",
      "`touch /tmp/atelier-shquote-pwned-2`",
      "; rm -rf /tmp/should-not-run; echo done",
      "a'b\"c$d`e",
    ];
    for (const value of dangerous) {
      const script = `printf '%s' ${shQuote(value)}`;
      const proc = Bun.spawnSync(["sh", "-c", script]);
      expect(proc.stdout.toString()).toBe(value);
    }
  });

  test("a build-arg value crafted to break out of the sh -c script cannot inject a command", async () => {
    // Mirrors the shape of the buildkit backend's script: `buildctl <args>;
    // grep ... > /dev/termination-log`. Without per-arg quoting, a build-arg
    // value containing `; <cmd>` would execute `<cmd>` as a sibling shell
    // statement instead of staying inside `buildctl`'s own argv.
    const marker = `/tmp/atelier-h1-pwned-${randomUUID()}`;
    const malicious = `x; touch ${marker}; echo `;
    const args = buildctlArgs(
      { ...baseReq, buildArgs: { KEY: malicious } },
      "tcp://buildkitd:1234",
      { secretName: "", serverName: "" },
    );
    // The exact construction buildkit.builder.ts's `build()` uses.
    const script = `set -e; echo ${args.map(shQuote).join(" ")} > /dev/null`;
    Bun.spawnSync(["sh", "-c", script]);
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

// ── H3: docker resolveDigest must filter RepoDigests by the tag's repo ─────

/** Writes an executable fake `docker` CLI that: replies to `inspect ...
 * <tag>` with a fixed `RepoDigests` JSON array (stdout), and no-ops (exit 0)
 * for every other subcommand (`build`, `push`) — enough to drive
 * `DockerImageBuilder.build()`'s full happy path without a real daemon. */
async function makeFakeDockerBin(repoDigestsJson: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atelier-fake-docker-"));
  const scriptPath = join(dir, "docker");
  await writeFile(
    scriptPath,
    `#!/bin/sh\ncase "$1" in\n  inspect) echo '${repoDigestsJson}' ;;\n  *) exit 0 ;;\nesac\n`,
    { mode: 0o755 },
  );
  return scriptPath;
}

describe("DockerImageBuilder digest resolution", () => {
  test("filters RepoDigests to the entry matching the tag's repo, not index 0", async () => {
    const tag = "myrepo/dev-base:latest";
    const wrongDigest = `sha256:${"b".repeat(64)}`;
    const correctDigest = `sha256:${"a".repeat(64)}`;
    // The foreign-repo entry is listed FIRST — the pre-H3 code took
    // `RepoDigests[0]` unconditionally and would have returned wrongDigest.
    const repoDigests = JSON.stringify([
      `otherrepo/dev-base@${wrongDigest}`,
      `myrepo/dev-base@${correctDigest}`,
    ]);
    const dockerBin = await makeFakeDockerBin(repoDigests);
    const builder = new DockerImageBuilder({ dockerBin });
    const ctx = await mkdtemp(join(tmpdir(), "atelier-fake-ctx-"));

    const result = await builder.build(
      {
        contextDir: ctx,
        dockerfile: "FROM scratch",
        tag,
        insecureRegistry: false,
      },
      () => {},
      new AbortController().signal,
    );

    expect(result.digest).toBe(correctDigest);
  });

  test("throws when no RepoDigests entry matches the tag's repo", async () => {
    const tag = "myrepo/dev-base:latest";
    const repoDigests = JSON.stringify([
      `otherrepo/dev-base@sha256:${"c".repeat(64)}`,
    ]);
    const dockerBin = await makeFakeDockerBin(repoDigests);
    const builder = new DockerImageBuilder({ dockerBin });
    const ctx = await mkdtemp(join(tmpdir(), "atelier-fake-ctx-"));

    expect(
      builder.build(
        {
          contextDir: ctx,
          dockerfile: "FROM scratch",
          tag,
          insecureRegistry: false,
        },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/no RepoDigests entry for repo/);
  });
});

// ── C1: deleteImage refuses while a build is in flight ─────────────────────

describe("ImageBuilderService.deleteImage", () => {
  function makeService() {
    const store = new InMemoryImageStore();
    return {
      store,
      service: new ImageBuilderService({
        store,
        builder: () => ({
          build: async () => ({ digest: `sha256:${"0".repeat(64)}` }),
        }),
        registryUrl: () => "zot.test.svc:5000",
        referencedImageRefs: () => [],
      }),
    };
  }

  test("refuses to delete a building image", () => {
    const { store, service } = makeService();
    store.put({
      name: "dev-base",
      provenance: "seed",
      status: "building",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(() => service.deleteImage("dev-base")).toThrow(ValidationError);
    expect(() => service.deleteImage("dev-base")).toThrow(/still building/);
    // The guard fired before any deletion — the row must still be there.
    expect(store.get("dev-base")).toBeDefined();
  });

  test("allows deleting a ready, unreferenced image", () => {
    const { store, service } = makeService();
    store.put({
      name: "dev-base",
      provenance: "seed",
      status: "ready",
      ref: "zot.test.svc:5000/dev-base@sha256:aaaa",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    service.deleteImage("dev-base");
    expect(store.get("dev-base")).toBeUndefined();
  });

  test("allows deleting an errored build", () => {
    const { store, service } = makeService();
    store.put({
      name: "dev-base",
      provenance: "seed",
      status: "error",
      error: "boom",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    service.deleteImage("dev-base");
    expect(store.get("dev-base")).toBeUndefined();
  });
});
