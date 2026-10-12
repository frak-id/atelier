import { describe, expect, test } from "bun:test";
import type { SshKey } from "../../types.ts";
import type { SshKeyRepository } from "./ssh-key.repository.ts";
import { SshKeyService } from "./ssh-key.service.ts";

const KEY = `ssh-ed25519 ${Buffer.from("k".padEnd(32, "-")).toString("base64")} me`;

/** A repository that stores what it is given. */
function service() {
  const created: SshKey[] = [];
  const repository = {
    create: (options: Partial<SshKey>) => {
      created.push(options as SshKey);
      return options as SshKey;
    },
  } as unknown as SshKeyRepository;
  return { created, svc: new SshKeyService(repository) };
}

const add = (svc: SshKeyService, publicKey: string) =>
  svc.create({
    userId: "u",
    username: "u",
    publicKey,
    name: "k",
    type: "uploaded",
  });

describe("SshKeyService.create", () => {
  test("stores the trimmed key", () => {
    const { svc, created } = service();
    add(svc, `${KEY}\n`);
    expect(created[0]?.publicKey).toBe(KEY);
  });

  test("rejects a key carrying more than one line", () => {
    const { svc, created } = service();
    for (const injected of [
      `${KEY}\nssh-ed25519 ${Buffer.from("x".padEnd(32, "-")).toString("base64")} evil`,
      `${KEY}\rcommand="id" ${KEY}`,
      `${KEY}\r\n${KEY}`,
    ]) {
      expect(() => add(svc, injected)).toThrow("Invalid SSH public key format");
    }
    expect(created).toEqual([]);
  });
});
