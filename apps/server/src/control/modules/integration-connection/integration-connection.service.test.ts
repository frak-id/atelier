import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlContainer } from "../../index.ts";
import {
  type IntegrationConnectionRepository,
  IntegrationConnectionService,
} from "./index.ts";

// Real AES-GCM (mock mode only base64-encodes).
process.env.ATELIER_SERVER_MODE = "local";
process.env.SANDBOX_SECRETS_KEY = "connection-test-key";

let dataDir: string;
let previousMode: string;
let control: ControlContainer;
let rawCredential: (userId: string, integrationId: string) => string | null;
let repository: InstanceType<typeof IntegrationConnectionRepository>;

beforeAll(async () => {
  // The env line above only counts if this file loads the config first.
  const { config } = await import("../../../shared/lib/config.ts");
  previousMode = config.server.mode;
  config.server.mode = "local";
  dataDir = await mkdtemp(join(tmpdir(), "atelier-connections-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../../../drizzle");
  const { initDatabase } = await import("../../db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../../index.ts");
  const { IntegrationConnectionRepository } = await import("./index.ts");
  control = createControlContainer();
  repository = new IntegrationConnectionRepository();
  rawCredential = (userId, integrationId) =>
    repository.get(userId, integrationId)?.credential ?? null;
});

afterAll(async () => {
  const { config } = await import("../../../shared/lib/config.ts");
  config.server.mode = previousMode as typeof config.server.mode;
  await rm(dataDir, { recursive: true, force: true });
});

describe("IntegrationConnectionService", () => {
  test("creates with defaults and never exposes the credential", async () => {
    const created = await control.integrationConnectionService.upsert(
      "u-create",
      "steery",
      { credential: "sk-secret" },
    );
    expect(created).toMatchObject({
      userId: "u-create",
      integrationId: "steery",
      hasCredential: true,
      enabled: true,
      minRisk: "high",
      delaySeconds: 0,
    });
    expect(JSON.stringify(created)).not.toContain("sk-secret");
    expect(
      control.integrationConnectionService.get("u-create", "steery"),
    ).toEqual(created);
    expect(control.integrationConnectionService.get("u-create", "other")).toBe(
      undefined,
    );
  });

  test("stores the credential encrypted", async () => {
    await control.integrationConnectionService.upsert("u-enc", "steery", {
      credential: "sk-secret",
    });
    const stored = rawCredential("u-enc", "steery");
    expect(stored).toStartWith("enc:");
    expect(stored).not.toContain("sk-secret");
    expect(stored).not.toContain(Buffer.from("sk-secret").toString("base64"));
    const [connection] =
      await control.integrationConnectionService.connectionsOf("u-enc");
    expect(connection?.credential).toBe("sk-secret");
  });

  test("upsert changes only the given fields; null clears the credential", async () => {
    const svc = control.integrationConnectionService;
    const first = await svc.upsert("u-up", "steery", {
      credential: "sk-1",
    });
    const second = await svc.upsert("u-up", "steery", {
      minRisk: "low",
      delaySeconds: 30,
    });
    expect(second).toMatchObject({
      id: first.id,
      createdAt: first.createdAt,
      hasCredential: true,
      minRisk: "low",
      delaySeconds: 30,
    });
    const cleared = await svc.upsert("u-up", "steery", {
      credential: null,
    });
    expect(cleared).toMatchObject({ hasCredential: false });
    expect(rawCredential("u-up", "steery")).toBeNull();
  });

  test("connectionsOf: enabled ones only, credential decrypted, per user", async () => {
    const svc = control.integrationConnectionService;
    await svc.upsert("u-list", "aa", {
      credential: "sk-aa",
      minRisk: "medium",
      delaySeconds: 5,
    });
    await svc.upsert("u-list", "bb", { enabled: false, credential: "sk-bb" });
    await svc.upsert("u-list", "cc", {});
    await svc.upsert("someone-else", "dd", { credential: "sk-dd" });
    const list = await svc.connectionsOf("u-list");
    expect(
      list.sort((a, b) => a.integrationId.localeCompare(b.integrationId)),
    ).toEqual([
      {
        integrationId: "aa",
        credential: "sk-aa",
        minRisk: "medium",
        delaySeconds: 5,
      },
      {
        integrationId: "cc",
        credential: undefined,
        minRisk: "high",
        delaySeconds: 0,
      },
    ]);
  });

  test("connectionsOf skips an undecryptable row and keeps the others", async () => {
    const svc = control.integrationConnectionService;
    await svc.upsert("u-bad", "good", { credential: "sk-good" });
    await svc.upsert("u-bad", "bad", { credential: "sk-bad" });
    const row = repository.get("u-bad", "bad");
    if (!row) throw new Error("missing row");
    repository.upsert({ ...row, credential: "enc:AAAA" });
    const list = await svc.connectionsOf("u-bad");
    expect(list.map((c) => [c.integrationId, c.credential])).toEqual([
      ["good", "sk-good"],
    ]);
  });

  test("delete removes the connection", async () => {
    const svc = control.integrationConnectionService;
    await svc.upsert("u-del", "steery", {});
    svc.delete("u-del", "steery");
    expect(svc.get("u-del", "steery")).toBeUndefined();
    expect(await svc.connectionsOf("u-del")).toEqual([]);
  });
});

describe("credentials in production", () => {
  const production = (secretsKey: string | undefined) =>
    new IntegrationConnectionService(repository, {
      isProduction: () => true,
      secretsKey: () => secretsKey,
    });

  test("are refused while SANDBOX_SECRETS_KEY is unset", async () => {
    const svc = production(undefined);
    const attempt = svc.upsert("u-prod", "steery", { credential: "sk-x" });
    await expect(attempt).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
      statusCode: 500,
      message: expect.stringContaining("SANDBOX_SECRETS_KEY"),
    });
    expect(svc.get("u-prod", "steery")).toBeUndefined();
  });

  test("are stored once it is set; a change without one is allowed", async () => {
    await production("k").upsert("u-prod", "steery", { credential: "sk-x" });
    expect(rawCredential("u-prod", "steery")).toStartWith("enc:");
    await production(undefined).upsert("u-prod2", "steery", { enabled: true });
    expect(
      await production(undefined).upsert("u-prod", "steery", {
        enabled: false,
      }),
    ).toMatchObject({ enabled: false });
  });
});
