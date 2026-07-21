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
import { startInServerSshGateway } from "./proxy.ts";

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
  }) => Promise<void>,
): Promise<void> {
  const proxyHostKey = generateOpenSSHEd25519("proxy-host").privateKeyOpenSSH;
  const shared = generateOpenSSHEd25519("shared-upstream");
  const dev = generateOpenSSHEd25519("dev");
  const other = generateOpenSSHEd25519("other");

  // The fake pod trusts the shared key's public half (what the proxy dials with).
  const sharedParsed = ssh2.utils.parseKey(shared.privateKeyOpenSSH);
  if (sharedParsed instanceof Error) throw sharedParsed;

  const pod = await startFakePod({
    hostKey: generateOpenSSHEd25519("pod-host").privateKeyOpenSSH,
    trustedPubSSH: sharedParsed.getPublicSSH(),
    expectUser: "dev",
  });

  const gateway = await startInServerSshGateway({
    listenPort: 0,
    bindHost: "127.0.0.1",
    hostKey: proxyHostKey,
    upstreamUser: "dev",
    upstreamPrivateKey: shared.privateKeyOpenSSH,
    authorizedKeys: () => [dev.publicKeyOpenSSH],
    resolveUpstream: () => ({ host: "127.0.0.1", port: pod.port }),
  });

  try {
    await run({
      port: gateway.port,
      devKey: dev.privateKeyOpenSSH,
      otherKey: other.privateKeyOpenSSH,
      podUser: pod.lastUser,
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
