/** Local SSH key discovery + generation, and fingerprinting that matches the
 * server's (`SshKeyService.computeFingerprint`) so the CLI can tell whether a
 * local key is already registered. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { type AtelierApi, unwrap } from "./client.ts";
import { runCapture } from "./proc.ts";

/** Where `ssh-key setup` writes the atelier-managed keypair. */
export const ATELIER_KEY_PATH = join(homedir(), ".ssh", "atelier_ed25519");

const SSH_DIR = join(homedir(), ".ssh");

export interface LocalKey {
  /** Path to the `.pub` file. */
  path: string;
  /** Full public key line (`ssh-ed25519 AAAA… comment`). */
  publicKey: string;
  /** `SHA256:…`, computed the same way the server does. */
  fingerprint: string;
}

/** Fingerprint a public key exactly as the server does: base64(sha256(raw key
 * bytes)), `SHA256:`-prefixed, trailing `=` stripped. Returns null for a line
 * that isn't a valid public key. */
export function fingerprint(publicKey: string): string | null {
  const parts = publicKey.trim().split(/\s+/);
  const keyDataBase64 = parts[1];
  if (!keyDataBase64) return null;
  try {
    const keyData = Buffer.from(keyDataBase64, "base64");
    const hash = createHash("sha256").update(keyData).digest("base64");
    return `SHA256:${hash.replace(/=+$/, "")}`;
  } catch {
    return null;
  }
}

const isPublicKeyLine = (line: string): boolean =>
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+|ssh-dss)\s+\S+/.test(line.trim());

/** Read one `.pub` file into a {@link LocalKey}, or null if it isn't a key. */
export function readLocalKey(pubPath: string): LocalKey | null {
  try {
    const publicKey = readFileSync(pubPath, "utf8").trim();
    if (!isPublicKeyLine(publicKey)) return null;
    const fp = fingerprint(publicKey);
    if (!fp) return null;
    return { path: pubPath, publicKey, fingerprint: fp };
  } catch {
    return null;
  }
}

/** All public keys under `~/.ssh`, atelier's own key first when present. */
export function listLocalKeys(): LocalKey[] {
  if (!existsSync(SSH_DIR)) return [];
  const keys: LocalKey[] = [];
  for (const name of readdirSync(SSH_DIR)) {
    if (!name.endsWith(".pub")) continue;
    const key = readLocalKey(join(SSH_DIR, name));
    if (key) keys.push(key);
  }
  const atelierPub = `${ATELIER_KEY_PATH}.pub`;
  keys.sort((a, b) =>
    a.path === atelierPub
      ? -1
      : b.path === atelierPub
        ? 1
        : a.path.localeCompare(b.path),
  );
  return keys;
}

export const atelierKeyExists = (): boolean =>
  existsSync(`${ATELIER_KEY_PATH}.pub`);

/** Cross-reference local `~/.ssh` public keys against the keys registered on
 * the server: returns every local key plus the first one the server knows
 * (undefined when none is registered). The single source of truth for SSH
 * readiness — used by `config doctor`, the cockpit's Account panel, and the
 * cockpit's shell gating. */
export async function resolveSshRegistration(api: AtelierApi): Promise<{
  localKeys: LocalKey[];
  registered: LocalKey | undefined;
}> {
  const localKeys = listLocalKeys();
  const remote = unwrap(await api.api["ssh-keys"].get());
  const registeredFps = new Set(remote.map((k) => k.fingerprint));
  return {
    localKeys,
    registered: localKeys.find((k) => registeredFps.has(k.fingerprint)),
  };
}

/** Delete the atelier-managed keypair (both halves) if present — used by
 * `regenerate`, which then writes a fresh one. */
export function removeAtelierKey(): void {
  for (const p of [ATELIER_KEY_PATH, `${ATELIER_KEY_PATH}.pub`]) {
    if (existsSync(p)) rmSync(p);
  }
}

/** A stable, human comment/name for the generated key: `atelier:user@host`. */
export function defaultKeyLabel(): string {
  const user = safeUser();
  return `atelier:${user}@${hostname()}`;
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "user";
  }
}

/** Generate an ed25519 keypair at {@link ATELIER_KEY_PATH} via `ssh-keygen`.
 * Refuses to overwrite an existing key. Returns the created public key. */
export async function generateAtelierKey(): Promise<LocalKey> {
  if (atelierKeyExists()) {
    const existing = readLocalKey(`${ATELIER_KEY_PATH}.pub`);
    if (existing) return existing;
  }
  const { code, stderr } = await runCapture([
    "ssh-keygen",
    "-t",
    "ed25519",
    "-f",
    ATELIER_KEY_PATH,
    "-N",
    "",
    "-C",
    defaultKeyLabel(),
  ]);
  if (code !== 0) {
    throw new Error(`ssh-keygen failed: ${stderr.trim() || `exit ${code}`}`);
  }
  const key = readLocalKey(`${ATELIER_KEY_PATH}.pub`);
  if (!key) throw new Error("ssh-keygen did not produce a readable public key");
  return key;
}
