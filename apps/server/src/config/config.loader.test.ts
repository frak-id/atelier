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

describe("validateConfig: serviceAccounts", () => {
  const KEY = `atl_${"a".repeat(40)}`;

  function withAccounts(
    accounts: AtelierConfig["serviceAccounts"],
    mode: "production" | "local" = "production",
  ): AtelierConfig {
    const config = productionConfig();
    config.server.mode = mode;
    config.serviceAccounts = accounts;
    return config;
  }

  test("none declared is the default and valid", () => {
    expect(schemaDefaults().serviceAccounts).toEqual([]);
  });

  test("names must be valid and unique, in every mode", () => {
    const accounts = [
      { name: "Bad_Name", org: "team" },
      { name: "ok", org: "team" },
      { name: "ok", org: "team" },
    ];
    for (const mode of ["production", "local"] as const) {
      const config = withAccounts(accounts, mode);
      expect(fields(config)).toEqual([
        "serviceAccounts[0].name",
        "serviceAccounts[2].name",
      ]);
    }
  });

  test("an App needs exactly one of privateKeyEnv and privateKeyFile", () => {
    const app = { appId: "1", installationId: "2" };
    process.env.SA_TEST_PEM = "pem";
    const both = withAccounts([
      {
        name: "a",
        org: "team",
        github: { ...app, privateKeyEnv: "SA_TEST_PEM", privateKeyFile: "/x" },
      },
    ]);
    const none = withAccounts([{ name: "a", org: "team", github: app }]);
    const one = withAccounts([
      {
        name: "a",
        org: "team",
        github: { ...app, privateKeyEnv: "SA_TEST_PEM" },
      },
    ]);
    expect(fields(both)).toEqual(["serviceAccounts[0].github"]);
    expect(fields(none)).toEqual(["serviceAccounts[0].github"]);
    expect(fields(one)).toEqual([]);
  });

  test("an empty repositories list is refused in every mode", () => {
    process.env.SA_TEST_PEM = "pem";
    const accounts = [
      {
        name: "a",
        org: "team",
        github: {
          appId: "1",
          installationId: "2",
          privateKeyEnv: "SA_TEST_PEM",
          repositories: [],
        },
      },
    ];
    for (const mode of ["production", "local"] as const) {
      expect(fields(withAccounts(accounts, mode))).toEqual([
        "serviceAccounts[0].github.repositories",
      ]);
    }
  });

  test("missing secrets and malformed keys fail production, not local", () => {
    delete process.env.SA_TEST_MISSING;
    delete process.env.SA_TEST_MISSING_KEY;
    process.env.SA_TEST_BADKEY = "atl_short";
    const accounts = [
      {
        name: "a",
        org: "team",
        github: {
          tokenEnv: "SA_TEST_MISSING",
          gitName: "n",
          gitEmail: "e@x",
        },
        apiKey: { env: "SA_TEST_BADKEY" },
      },
      { name: "b", org: "team", apiKey: { env: "SA_TEST_MISSING_KEY" } },
    ];
    expect(fields(withAccounts(accounts))).toEqual([
      "serviceAccounts[0].github.tokenEnv",
      "serviceAccounts[0].apiKey.env",
      "serviceAccounts[1].apiKey.env",
    ]);
    expect(fields(withAccounts(accounts, "local"))).toEqual([]);
    process.env.SA_TEST_BADKEY = KEY;
    process.env.SA_TEST_MISSING = "ghp_x";
    process.env.SA_TEST_MISSING_KEY = KEY;
    expect(fields(withAccounts(accounts))).toEqual([]);
  });
});
