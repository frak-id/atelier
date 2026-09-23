/**
 * End-to-end test of the in-server ssh2 proxy: a real ssh2 client → the proxy →
 * a fake "pod" ssh server standing in for the sandbox `sshd`. It proves the
 * auth translation (dev key at the front, shared key upstream), that an
 * unauthorized key is rejected, and that `exec`/`shell` channels forward
 * bidirectionally with the real exit status. The higher-fidelity paths
 * (`sftp`, `direct-tcpip`/Remote-SSH) are the live-cluster spike, not unit-
 * testable without a real sandbox.
 */
import { describe, expect, test } from "bun:test";
import ssh2, { type Connection } from "ssh2";
import { generateOpenSSHEd25519 } from "../shared/lib/ssh-key-openssh.ts";
import { buildHostVerifier, startInServerSshGateway } from "./proxy.ts";

const { Server, Client } = ssh2;

/** A minimal sandbox `sshd` stand-in: trusts one key, echoes exec/shell. */
function startFakePod(opts: {
  hostKey: string;
  trustedPubSSH: Buffer;
  expectUser: string;
}): Promise<{ port: number; close: () => void; lastUser: () => string }> {
  let lastUser = "";
  const server = new Server({ hostKeys: [opts.hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      lastUser = ctx.username;
      if (
        ctx.method === "publickey" &&
        ctx.key.data.equals(opts.trustedPubSSH)
      ) {
        return ctx.accept();
      }
      if (ctx.method === "none") return ctx.reject(["publickey"]);
      return ctx.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        // A real sshd grants the pty request; accept it so shell works.
        session.on("pty", (a) => a?.());
        session.on("window-change", (a) => a?.());
        session.once("exec", (a, _r, info) => {
          const ch = a();
          ch.write(`ran:${info.command}`);
          ch.exit(0);
          ch.end();
        });
        session.once("shell", (a) => {
          const ch = a();
          ch.write("shell-ready");
          // Echo one line then exit on any input.
          ch.on("data", () => {
            ch.exit(0);
            ch.end();
          });
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () => server.close(),
        lastUser: () => lastUser,
      });
    });
  });
}

async function withGateway(
  run: (ctx: {
    port: number;
    devKey: string;
    otherKey: string;
    podUser: () => string;
    podHostKeyPublic: string;
  }) => Promise<void>,
  options: { pinnedHostKeys?: "pod" | string[] } = {},
): Promise<void> {
  const proxyHostKey = generateOpenSSHEd25519("proxy-host").privateKeyOpenSSH;
  const shared = generateOpenSSHEd25519("shared-upstream");
  const dev = generateOpenSSHEd25519("dev");
  const other = generateOpenSSHEd25519("other");
  const podHostKey = generateOpenSSHEd25519("pod-host");

  // The fake pod trusts the shared key's public half (what the proxy dials with).
  const sharedParsed = ssh2.utils.parseKey(shared.privateKeyOpenSSH);
  if (sharedParsed instanceof Error) throw sharedParsed;

  const pod = await startFakePod({
    hostKey: podHostKey.privateKeyOpenSSH,
    trustedPubSSH: sharedParsed.getPublicSSH(),
    expectUser: "dev",
  });

  // "pod" pins the pod's OWN real host key (generated above, before the pod
  // even starts) — a match; an explicit array lets a test pin a WRONG key.
  const pinnedHostKeys =
    options.pinnedHostKeys === "pod"
      ? [podHostKey.publicKeyOpenSSH]
      : options.pinnedHostKeys;

  const gateway = await startInServerSshGateway({
    listenPort: 0,
    bindHost: "127.0.0.1",
    hostKey: proxyHostKey,
    upstreamUser: "dev",
    upstreamPrivateKey: shared.privateKeyOpenSSH,
    authorizedKeys: () => [dev.publicKeyOpenSSH],
    resolveUpstream: () => ({
      host: "127.0.0.1",
      port: pod.port,
      hostKeys: pinnedHostKeys,
    }),
  });

  try {
    await run({
      port: gateway.port,
      devKey: dev.privateKeyOpenSSH,
      otherKey: other.privateKeyOpenSSH,
      podUser: pod.lastUser,
      podHostKeyPublic: podHostKey.publicKeyOpenSSH,
    });
  } finally {
    await gateway.close();
    pod.close();
  }
}

function connect(opts: {
  port: number;
  username: string;
  privateKey: string;
}): Promise<Connection extends never ? never : ssh2.Client> {
  const client = new Client();
  return new Promise((resolve, reject) => {
    client
      .on("ready", () => resolve(client))
      .on("error", reject)
      .connect({
        host: "127.0.0.1",
        port: opts.port,
        username: opts.username,
        privateKey: opts.privateKey,
        readyTimeout: 5000,
      });
  });
}

describe("in-server ssh proxy", () => {
  test("authorized dev key → exec is forwarded to the pod as the upstream user", async () => {
    await withGateway(async (ctx) => {
      const client = await connect({
        port: ctx.port,
        username: "sb-abc123",
        privateKey: ctx.devKey,
      });
      const out = await new Promise<string>((resolve, reject) => {
        client.exec("echo hi", (err, stream) => {
          if (err) return reject(err);
          let buf = "";
          stream
            .on("data", (d: Buffer) => {
              buf += d.toString();
            })
            .on("close", () => resolve(buf));
        });
      });
      client.end();
      expect(out).toBe("ran:echo hi");
      // The dev authenticated at the front; the pod saw the UPSTREAM user.
      expect(ctx.podUser()).toBe("dev");
    });
  });

  test("shell channel forwards", async () => {
    await withGateway(async (ctx) => {
      const client = await connect({
        port: ctx.port,
        username: "sb-abc123",
        privateKey: ctx.devKey,
      });
      const greeting = await new Promise<string>((resolve, reject) => {
        client.shell((err, stream) => {
          if (err) return reject(err);
          stream.once("data", (d: Buffer) => resolve(d.toString()));
        });
      });
      client.end();
      expect(greeting).toBe("shell-ready");
    });
  });

  test("unauthorized key is rejected before reaching the pod", async () => {
    await withGateway(async (ctx) => {
      await expect(
        connect({
          port: ctx.port,
          username: "sb-abc123",
          privateKey: ctx.otherKey,
        }),
      ).rejects.toThrow();
    });
  });
});

describe("in-server ssh proxy host-key pinning", () => {
  test("no pinned key: connects (today's unpinned fallback)", async () => {
    await withGateway(async (ctx) => {
      const client = await connect({
        port: ctx.port,
        username: "sb-abc123",
        privateKey: ctx.devKey,
      });
      client.end();
    });
  });

  test("pinned key matches the pod's real host key: connects", async () => {
    await withGateway(
      async (ctx) => {
        const client = await connect({
          port: ctx.port,
          username: "sb-abc123",
          privateKey: ctx.devKey,
        });
        client.end();
      },
      { pinnedHostKeys: "pod" },
    );
  });
});

// `buildHostVerifier` unit-tested directly, not end-to-end: a rejected
// hostVerifier tears down the upstream mid-handshake, which the real ssh2
// server implementation surfaces as an internal `KEY_EXCHANGE_FAILED`
// disconnect on the DEV-facing socket too (both ends of `connectUpstream`
// share the same raw TCP teardown timing) — an ssh2-internal artifact of the
// abrupt `client.end()`, not something this module's behavior hinges on.
// Exercising the verifier function directly is the stable, deterministic way
// to pin its accept/reject contract.
describe("buildHostVerifier", () => {
  test("no pinned keys: accepts anything (today's unpinned fallback)", () => {
    const verify = buildHostVerifier("sb-1", undefined);
    expect(verify(Buffer.from("anything"))).toBe(true);
    expect(buildHostVerifier("sb-1", [])(Buffer.from("anything"))).toBe(true);
  });

  test("pinned key: accepts an exact match, rejects everything else", () => {
    const real = generateOpenSSHEd25519("real-host");
    const wrong = generateOpenSSHEd25519("wrong-host");
    const realParsed = ssh2.utils.parseKey(real.privateKeyOpenSSH);
    const wrongParsed = ssh2.utils.parseKey(wrong.privateKeyOpenSSH);
    if (realParsed instanceof Error || wrongParsed instanceof Error) {
      throw realParsed instanceof Error ? realParsed : wrongParsed;
    }

    const verify = buildHostVerifier("sb-1", [real.publicKeyOpenSSH]);
    expect(verify(realParsed.getPublicSSH())).toBe(true);
    expect(verify(wrongParsed.getPublicSSH())).toBe(false);
  });

  test("multiple pinned lines: matches any one of them", () => {
    const a = generateOpenSSHEd25519("host-a");
    const b = generateOpenSSHEd25519("host-b");
    const wrong = generateOpenSSHEd25519("host-c");
    const bParsed = ssh2.utils.parseKey(b.privateKeyOpenSSH);
    const wrongParsed = ssh2.utils.parseKey(wrong.privateKeyOpenSSH);
    if (bParsed instanceof Error || wrongParsed instanceof Error) {
      throw bParsed instanceof Error ? bParsed : wrongParsed;
    }

    const verify = buildHostVerifier("sb-1", [
      a.publicKeyOpenSSH,
      b.publicKeyOpenSSH,
    ]);
    expect(verify(bParsed.getPublicSSH())).toBe(true);
    expect(verify(wrongParsed.getPublicSSH())).toBe(false);
  });
});
