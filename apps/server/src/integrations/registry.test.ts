import { describe, expect, test } from "bun:test";
import type { Integration, ServerSettingDef } from "./integration.ts";
import {
  createIntegrationRegistry,
  integrationEnvName,
  settingEnvName,
} from "./registry.ts";

function integration(
  id: string,
  serverSettings?: ServerSettingDef[],
): Integration {
  return {
    manifest: { id, label: id, description: "d", serverSettings },
  };
}

const url: ServerSettingDef = {
  name: "url",
  type: "url",
  default: "https://steery.dev",
};

describe("environment names", () => {
  test("id upper-cased with - → _, name camelCase → UPPER_SNAKE", () => {
    expect(integrationEnvName("my-ui")).toBe("ATELIER_INTEGRATION_MY_UI");
    expect(settingEnvName("my-ui", "url")).toBe(
      "ATELIER_INTEGRATION_MY_UI_URL",
    );
    expect(settingEnvName("a", "apiBaseUrl")).toBe(
      "ATELIER_INTEGRATION_A_API_BASE_URL",
    );
  });
});

describe("createIntegrationRegistry", () => {
  test("every integration is off by default", () => {
    const registry = createIntegrationRegistry([integration("steery")], {});
    expect(registry.enabled()).toEqual([]);
    expect(registry.get("steery")).toBeUndefined();
    expect(registry.isKnown("steery")).toBe(true);
    expect(registry.isKnown("nope")).toBe(false);
    expect(registry.serverSettings("steery")).toEqual({});
  });

  test("true and 1 turn it on; anything else leaves it off", () => {
    const catalog = [integration("aa"), integration("bb"), integration("cc")];
    const registry = createIntegrationRegistry(catalog, {
      ATELIER_INTEGRATION_AA: "true",
      ATELIER_INTEGRATION_BB: "1",
      ATELIER_INTEGRATION_CC: "yes",
    });
    expect(registry.enabled().map((i) => i.manifest.id)).toEqual(["aa", "bb"]);
    expect(registry.get("cc")).toBeUndefined();
  });

  test("settings come from the environment, defaults fill the gaps", () => {
    const catalog = [integration("steery", [url])];
    const on = { ATELIER_INTEGRATION_STEERY: "true" };
    expect(
      createIntegrationRegistry(catalog, on).serverSettings("steery"),
    ).toEqual({ url: "https://steery.dev" });
    expect(
      createIntegrationRegistry(catalog, {
        ...on,
        ATELIER_INTEGRATION_STEERY_URL: "https://self.example",
      }).serverSettings("steery"),
    ).toEqual({ url: "https://self.example" });
  });

  test("ids that collide after the env transform throw", () => {
    expect(() =>
      createIntegrationRegistry([integration("a-b"), integration("a_b")], {}),
    ).toThrow();
    // a setting's variable can equal another integration's flag
    expect(() =>
      createIntegrationRegistry(
        [integration("aa", [{ ...url, name: "bb" }]), integration("aa-bb")],
        {},
      ),
    ).toThrow("ATELIER_INTEGRATION_AA_BB");
  });

  test("bad ids and setting names, and duplicate names, throw", () => {
    expect(() => createIntegrationRegistry([integration("A")], {})).toThrow(
      "Invalid integration id",
    );
    expect(() =>
      createIntegrationRegistry(
        [integration("aa", [{ ...url, name: "Bad_Name" }])],
        {},
      ),
    ).toThrow("Invalid setting name");
    expect(() =>
      createIntegrationRegistry([integration("aa", [url, url])], {}),
    ).toThrow();
  });

  test("an enabled url setting must parse", () => {
    expect(() =>
      createIntegrationRegistry([integration("aa", [url])], {
        ATELIER_INTEGRATION_AA: "true",
        ATELIER_INTEGRATION_AA_URL: "not a url",
      }),
    ).toThrow("ATELIER_INTEGRATION_AA_URL");
  });

  test("a url setting must be https in production, http allowed otherwise", () => {
    const catalog = [integration("aa", [url])];
    const env = {
      ATELIER_INTEGRATION_AA: "true",
      ATELIER_INTEGRATION_AA_URL: "http://steery.local",
    };
    expect(() => createIntegrationRegistry(catalog, env, true)).toThrow(
      "https",
    );
    expect(
      createIntegrationRegistry(catalog, env, false).serverSettings("aa"),
    ).toEqual({ url: "http://steery.local" });
  });

  test("a disabled integration's settings are not validated", () => {
    const registry = createIntegrationRegistry([integration("aa", [url])], {
      ATELIER_INTEGRATION_AA_URL: "nope",
    });
    expect(registry.enabled()).toEqual([]);
  });
});
