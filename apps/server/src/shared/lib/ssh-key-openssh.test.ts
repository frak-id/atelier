/**
 * The ed25519 → OpenSSH encoder is the bridge that lets `ssh2` load keys Node
 * emits as PKCS8 PEM (which ssh2 rejects). These tests pin that both a freshly
 * generated key and a re-encoded PKCS8 key parse in ssh2 and keep their public
 * identity.
 */
import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import {
  generateOpenSSHEd25519,
  pkcs8PemToOpenSSHEd25519,
} from "./ssh-key-openssh.ts";

const { utils } = ssh2;

describe("generateOpenSSHEd25519", () => {
  test("produces a private key ssh2 can parse + a matching public line", () => {
    const { privateKeyOpenSSH, publicKeyOpenSSH } =
      generateOpenSSHEd25519("test");
    const parsed = utils.parseKey(privateKeyOpenSSH);
    expect(parsed).not.toBeInstanceOf(Error);
    if (parsed instanceof Error) return;
    expect(parsed.type).toBe("ssh-ed25519");
    // The public half derived from the private matches the emitted public line.
    const emittedB64 = publicKeyOpenSSH.split(" ")[1] ?? "";
    expect(parsed.getPublicSSH().toString("base64")).toBe(emittedB64);
  });

  test("ssh2.Server accepts it as a host key", () => {
    const { privateKeyOpenSSH } = generateOpenSSHEd25519();
    const server = new ssh2.Server({ hostKeys: [privateKeyOpenSSH] }, () => {});
    server.close();
  });
});

describe("pkcs8PemToOpenSSHEd25519", () => {
  test("re-encodes a Node PKCS8 PEM into a parseable OpenSSH key with the same identity", () => {
    // Mirror ensureSharedSshPipeKey: ed25519 exported as PKCS8 PEM.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pkcs8Pem = privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;

    const { privateKeyOpenSSH } = pkcs8PemToOpenSSHEd25519(pkcs8Pem);
    const parsed = utils.parseKey(privateKeyOpenSSH);
    expect(parsed).not.toBeInstanceOf(Error);
    if (parsed instanceof Error) return;

    // Same public key as Node derives from the original private key.
    const spkiDer = publicKey.export({ type: "spki", format: "der" });
    const rawPub = Buffer.from(spkiDer.subarray(spkiDer.length - 32));
    const keyType = Buffer.from("ssh-ed25519");
    const len = (b: Buffer) => {
      const l = Buffer.alloc(4);
      l.writeUInt32BE(b.length, 0);
      return l;
    };
    const expectedBlob = Buffer.concat([
      len(keyType),
      keyType,
      len(rawPub),
      rawPub,
    ]);
    expect(parsed.getPublicSSH().equals(expectedBlob)).toBe(true);
  });
});
