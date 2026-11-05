import { describe, expect, test } from "bun:test";
import { schemaDefaults, validateConfig } from "./config.loader.ts";
import type { AtelierConfig } from "./config.schema.ts";

/** A production config that passes every production check. */
function productionConfig(): AtelierConfig {
  const config = schemaDefaults();
  config.server.mode = "production";
  config.auth.github.clientId = "id";
  config.auth.github.clientSecret = "secret";
  config.auth.jwtSecret = "a-real-jwt-secret";
  config.auth.defaultOrg = "team";
  config.domain.baseDomain = "atelier.example.com";
  return config;
}

const fields = (config: AtelierConfig) =>
  validateConfig(config).map((e) => e.field);

describe("validateConfig", () => {
  test("a complete production config has no errors", () => {
    expect(validateConfig(productionConfig())).toEqual([]);
  });

  test("production requires auth.defaultOrg (its owners are the admins)", () => {
    const config = productionConfig();
    config.auth.defaultOrg = undefined;
    expect(fields(config)).toContain("auth.defaultOrg");
  });

  test("local mode runs without a default org", () => {
    const config = schemaDefaults();
    config.server.mode = "local";
    expect(fields(config)).not.toContain("auth.defaultOrg");
  });

  test("an unknown server mode is a schema error", () => {
    const config = schemaDefaults();
    (config.server as { mode: string }).mode = "mock";
    expect(fields(config)).toContain("/server/mode");
  });
});
