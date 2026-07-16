/**
 * The proxy host key must be generated once and then stable across restarts
 * (a changing host key = client MITM warnings). This pins that persistence
 * against an in-memory secret store standing in for `SecretService`.
 */
import { describe, expect, test } from "bun:test";
import ssh2 from "ssh2";
import type { SecretService } from "../control/index.ts";
import { ensureInServerHostKey, SSH_HOST_KEY_SECRET } from "./host-key.ts";

/** Minimal in-memory SecretService double (only resolve/set are used). */
function fakeSecrets(): SecretService & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    resolve(_orgId: string | undefined, name: string) {
      const v = store.get(name);
      return v === undefined
        ? Promise.reject(new Error("not found"))
        : Promise.resolve(v);
    },
    set(_orgId: string | undefined, name: string, value: string) {
      store.set(name, value);
      return Promise.resolve({ id: name, name, createdAt: "", updatedAt: "" });
    },
  } as unknown as SecretService & { store: Map<string, string> };
}

describe("ensureInServerHostKey", () => {
  test("generates once, then returns the same key on subsequent calls", async () => {
    const secrets = fakeSecrets();
    const first = await ensureInServerHostKey(secrets);
    const second = await ensureInServerHostKey(secrets);
    expect(first).toBe(second);
    expect(secrets.store.get(SSH_HOST_KEY_SECRET)).toBe(first);
    // It is a valid OpenSSH host key ssh2 can load.
    expect(ssh2.utils.parseKey(first)).not.toBeInstanceOf(Error);
  });
});
