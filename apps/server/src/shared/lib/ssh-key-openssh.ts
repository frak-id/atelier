/**
 * ed25519 → OpenSSH private-key encoding. `ssh2` only accepts private keys in
 * the OpenSSH (`-----BEGIN OPENSSH PRIVATE KEY-----`) or PEM RSA/ECDSA formats;
 * it rejects the PKCS8 PEM that Node's `crypto` emits for ed25519. This module
 * bridges that gap: it produces an unencrypted OpenSSH-format ed25519 private
 * key (plus its OpenSSH public line) from either a fresh keypair or an existing
 * PKCS8 PEM (the shared ssh-pipe key material), so the in-server ssh2 proxy can
 * load both its host key and its upstream key.
 *
 * The OpenSSH private-key container is documented in PROTOCOL.key (OpenSSH):
 *   "openssh-key-v1\0" | cipher | kdf | kdfopts | nkeys | pubkey | privsection
 * with the (unencrypted) privsection = check | check | keytype | pub | priv |
 * comment | padding(1,2,3,…) to an 8-byte boundary.
 */
import { Buffer } from "node:buffer";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

export interface OpenSSHEd25519Key {
  /** Unencrypted OpenSSH-format private key (PEM-wrapped), for `ssh2`. */
  privateKeyOpenSSH: string;
  /** `ssh-ed25519 <base64> <comment>` public line. */
  publicKeyOpenSSH: string;
}

/** SSH wire `string`: 4-byte big-endian length prefix + bytes. */
function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function sshUint32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value, 0);
  return b;
}

const KEY_TYPE = Buffer.from("ssh-ed25519");

function publicKeyBlob(rawPub: Buffer): Buffer {
  return Buffer.concat([sshString(KEY_TYPE), sshString(rawPub)]);
}

/** Raw 32-byte ed25519 public key from a Node public `KeyObject`. */
function rawPublicKey(publicKey: KeyObject): Buffer {
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  return Buffer.from(spkiDer.subarray(spkiDer.length - 32));
}

/**
 * Assemble the OpenSSH artifacts from the raw 32-byte seed + 32-byte public.
 * The private field is `seed || pub` (64 bytes), per the ed25519 layout.
 */
function encode(
  seed: Buffer,
  rawPub: Buffer,
  comment: string,
): OpenSSHEd25519Key {
  const pubBlob = publicKeyBlob(rawPub);
  const priv64 = Buffer.concat([seed, rawPub]);
  // The two check ints must match; the value itself is arbitrary.
  const check = sshUint32(0x0a0b0c0d);
  let privSection = Buffer.concat([
    check,
    check,
    sshString(KEY_TYPE),
    sshString(rawPub),
    sshString(priv64),
    sshString(Buffer.from(comment)),
  ]);
  for (let pad = 1; privSection.length % 8 !== 0; pad++) {
    privSection = Buffer.concat([privSection, Buffer.from([pad & 0xff])]);
  }

  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshString(Buffer.from("none")), // ciphername
    sshString(Buffer.from("none")), // kdfname
    sshString(Buffer.alloc(0)), // kdfoptions
    sshUint32(1), // number of keys
    sshString(pubBlob),
    sshString(privSection),
  ]);

  const b64 = body.toString("base64").replace(/(.{70})/g, "$1\n");
  const privateKeyOpenSSH = `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
  const publicKeyOpenSSH = `ssh-ed25519 ${pubBlob.toString("base64")} ${comment}`;
  return { privateKeyOpenSSH, publicKeyOpenSSH };
}

/** Generate a fresh ed25519 keypair in OpenSSH form. */
export function generateOpenSSHEd25519(comment = "atelier"): OpenSSHEd25519Key {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pkcs8Der = privateKey.export({ type: "pkcs8", format: "der" });
  const seed = Buffer.from(pkcs8Der.subarray(pkcs8Der.length - 32));
  return encode(seed, rawPublicKey(publicKey), comment);
}

/**
 * Re-encode an existing PKCS8 PEM ed25519 private key (e.g. the shared
 * ssh-pipe key material) into OpenSSH form. The 32-byte seed is the tail of the
 * PKCS8 DER; the public key is derived from it.
 */
export function pkcs8PemToOpenSSHEd25519(
  pkcs8Pem: string,
  comment = "atelier",
): OpenSSHEd25519Key {
  const privateKey = createPrivateKey(pkcs8Pem);
  const pkcs8Der = privateKey.export({ type: "pkcs8", format: "der" });
  const seed = Buffer.from(pkcs8Der.subarray(pkcs8Der.length - 32));
  return encode(seed, rawPublicKey(createPublicKey(privateKey)), comment);
}
