/**
 * The config plane split: infrastructure keys are never editable, operational
 * (plane) keys are, and the listing exposes the flag the console groups by.
 */
import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../../shared/errors.ts";
import type { ConfigValue } from "./registry.ts";
import type { ServerConfigRepository } from "./server-config.repository.ts";
import { ServerConfigService } from "./server-config.service.ts";

function memoryService() {
  const rows = new Map<string, ConfigValue>();
  const repository = {
    get: (key: string) => {
      const value = rows.get(key);
      return value === undefined
        ? undefined
        : { key, value, updatedAt: "2026-01-01T00:00:00.000Z" };
    },
    set: (key: string, value: ConfigValue) => void rows.set(key, value),
  } as unknown as ServerConfigRepository;
  return { service: new ServerConfigService(repository), rows };
}

describe("ServerConfigService plane split", () => {
  test("rejects writes to infrastructure keys", () => {
    const { service, rows } = memoryService();
    expect(() => service.set("kubernetes.registryUrl", "r:5000")).toThrow(
      ValidationError,
    );
    expect(rows.size).toBe(0);
  });

  test("stores and reads back an operational key", () => {
    const { service } = memoryService();
    // Unset in the test environment, so the console override applies.
    expect(service.set("snapshot.manualKeep", 7)).toBe(7);
    expect(service.get("snapshot.manualKeep")).toBe(7);
  });

  test("lists the plane flag and locks infrastructure keys", () => {
    const { service } = memoryService();
    const entries = service.list();
    const registry = entries.find((e) => e.key === "kubernetes.registryUrl");
    const keep = entries.find((e) => e.key === "snapshot.manualKeep");
    expect(registry).toMatchObject({ plane: false, locked: true });
    expect(keep).toMatchObject({ plane: true, locked: false });
  });
});
