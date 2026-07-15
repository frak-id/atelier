/**
 * Unit coverage for the cluster-native builders' PURE pieces — arg/manifest
 * construction, context packaging, and digest read-back. The Job I/O itself
 * (submit/watch/stream) needs a real cluster and is exercised there; these
 * lock the parts that must stay correct regardless.
 */

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

process.env.ATELIER_SERVER_MODE = "mock";

const { kanikoArgs } = await import("./kaniko.builder.ts");
const { buildctlArgs } = await import("./buildkit.builder.ts");
const {
  buildJobManifest,
  extractDigest,
  jobResourceName,
  stageContextTarball,
} = await import("./k8s-build-job.ts");

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
    expect(podSpec.initContainers[0].name).toBe("unpack");
    expect(podSpec.containers[0].name).toBe("build");
    expect(podSpec.containers[0].image).toBe("kaniko:latest");
    expect(podSpec.containers[0].terminationMessagePolicy).toBe("File");
    expect(podSpec.volumes[0].configMap?.name).toBe(
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
