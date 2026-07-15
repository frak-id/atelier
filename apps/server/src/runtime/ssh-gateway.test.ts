/**
 * SSH gateway strategy: which resources a boot emits + which secret the pod
 * mounts as its authorized_keys, per `ssh.gateway`. Pins the "sshpiper is
 * optional" contract (proposal §5). Mock mode: `ensureSharedSshPipeKey`
 * generates an in-memory key and its kube writes no-op.
 */
import { describe, expect, test } from "bun:test";

process.env.ATELIER_SERVER_MODE = "mock";

const { resolveSshGatewayBoot, sshAuthKeysSecretName } = await import(
  "./ssh-gateway.ts"
);

const ID = "sb-test";
const KEYS = ["ssh-ed25519 AAAAkey1 a@h", "ssh-ed25519 AAAAkey2 b@h"];

function kinds(resources: { kind: string }[]): string[] {
  return resources.map((r) => r.kind);
}

describe("resolveSshGatewayBoot", () => {
  test("sshpiper: pod trusts the shared key + a Pipe carries the dev keys", async () => {
    const boot = await resolveSshGatewayBoot(ID, KEYS, "sshpiper");
    // Shared-key secret (not the per-sandbox one).
    expect(boot.podAuthKeysSecret).toBeDefined();
    expect(boot.podAuthKeysSecret).not.toBe(sshAuthKeysSecretName(ID));
    expect(kinds(boot.resources)).toEqual(["Pipe"]);

    const pipe = boot.resources[0] as unknown as {
      spec: {
        from: [{ username: string; authorized_keys_data?: string }];
        to: { username: string; private_key_secret?: { name: string } };
      };
    };
    const from = pipe.spec.from[0];
    expect(from.username).toBe(ID);
    // Dev keys ride the Pipe, base64-encoded.
    expect(from.authorized_keys_data).toBe(
      Buffer.from(KEYS.join("\n")).toString("base64"),
    );
    expect(pipe.spec.to.username).toBe("dev");
    expect(pipe.spec.to.private_key_secret?.name).toBe(boot.podAuthKeysSecret);
  });

  test("none: pod trusts the dev's own keys via a per-sandbox Secret, no Pipe", async () => {
    const boot = await resolveSshGatewayBoot(ID, KEYS, "none");
    expect(boot.podAuthKeysSecret).toBe(sshAuthKeysSecretName(ID));
    expect(kinds(boot.resources)).toEqual(["Secret"]);

    const secret = boot.resources[0] as unknown as {
      metadata: { name: string; labels: Record<string, string> };
      data: { "ssh-publickey": string };
    };
    expect(secret.metadata.name).toBe(sshAuthKeysSecretName(ID));
    // Labeled so destroy's sweep and deleteRestartable both reach it.
    expect(secret.metadata.labels["atelier.dev/sandbox"]).toBe(ID);
    expect(secret.data["ssh-publickey"]).toBe(
      Buffer.from(KEYS.join("\n")).toString("base64"),
    );
  });

  test("none without keys: no SSH at all (no secret, no mount)", async () => {
    const boot = await resolveSshGatewayBoot(ID, undefined, "none");
    expect(boot.podAuthKeysSecret).toBeUndefined();
    expect(boot.resources).toEqual([]);
  });

  test("in-server: pod trusts the shared key, but emits NO Pipe (listener does routing)", async () => {
    const boot = await resolveSshGatewayBoot(ID, KEYS, "in-server");
    expect(boot.podAuthKeysSecret).toBeDefined();
    expect(boot.podAuthKeysSecret).not.toBe(sshAuthKeysSecretName(ID));
    expect(boot.resources).toEqual([]);
  });
});
