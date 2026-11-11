import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSecretRef } from "@atelier/spec";
import { surfaceValid } from "./runtime-surface.ts";
import { parseToolboxInput } from "./spec.ts";
import {
  CLIPROXY_ENDPOINT_PLACEHOLDER,
  findToolboxSuggestion,
  missingSecrets,
  pendingSuggestions,
  TOOLBOX_SUGGESTIONS,
} from "./toolbox-suggestions.ts";

describe("toolbox suggestions", () => {
  test.each(TOOLBOX_SUGGESTIONS.map((s) => [s.id, s] as const))(
    "%s is a valid toolbox the editor can save",
    (_, suggestion) => {
      const parsed = parseToolboxInput(JSON.stringify(suggestion.input));
      expect(parsed.ok ? [] : parsed.errors).toEqual([]);
      expect(surfaceValid(suggestion.input)).toBe(true);
    },
  );

  test("ids and slugs are unique", () => {
    const ids = TOOLBOX_SUGGESTIONS.map((s) => s.id);
    const slugs = TOOLBOX_SUGGESTIONS.map((s) => s.input.slug);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("declared secrets are exactly the ones the files read", () => {
    for (const suggestion of TOOLBOX_SUGGESTIONS) {
      const read = (suggestion.input.files ?? []).flatMap((file) =>
        isSecretRef(file.content) ? [file.content.$secret] : [],
      );
      expect(read).toEqual(suggestion.secrets);
    }
  });

  test("opencode provides its harness and installs only opencode", () => {
    const opencode = findToolboxSuggestion("opencode")?.input;
    expect(opencode?.harness).toBe("opencode");
    expect(opencode?.paths).toEqual(["~/.local/bin/opencode"]);
    expect(opencode?.processes).toBeUndefined();
  });

  test("pi ships its packages and reads the key from CLIPROXY_KEY", () => {
    const pi = findToolboxSuggestion("pi-cliproxy");
    expect(pi?.input.harness).toBe("pi");
    for (const name of [
      "pi-subagents",
      "pi-blackhole",
      "pi-intercom",
      "pi-web-access",
      "pi-cliproxyapi",
    ]) {
      expect(pi?.input.build).toContain(`pi install npm:${name}`);
    }
    // The harness runs ~/.local/bin/pi-acp.
    expect(pi?.input.paths).toContain("~/.local/bin/pi-acp");

    const files = pi?.input.files ?? [];
    const keyFile = files.find((file) => isSecretRef(file.content));
    expect(keyFile?.content).toEqual({ $secret: "CLIPROXY_KEY" });
    expect(keyFile?.mode).toBe("600");

    const configFile = files.find((file) =>
      file.path.endsWith("/.pi/agent/pi-cliproxyapi/config.json"),
    );
    const config = JSON.parse(String(configFile?.content));
    expect(config.proxy.apiKey).toBe(`!cat ${keyFile?.path}`);
    expect(config.proxy.endpoint).toBe(CLIPROXY_ENDPOINT_PLACEHOLDER);
  });

  test("code-server serves its lazy process behind forward auth", () => {
    const codeServer = findToolboxSuggestion("code-server")?.input;
    expect(codeServer?.harness).toBeUndefined();
    expect(codeServer?.processes?.[0]).toMatchObject({
      name: "vscode",
      lazy: true,
      user: "dev",
    });
    expect(codeServer?.ports).toEqual([
      { name: "vscode", port: 8080, public: true, auth: "forward" },
    ]);
  });

  test("code-server's settings step writes the settings it captures", () => {
    const codeServer = findToolboxSuggestion("code-server")?.input;
    const settingsPath = "~/.local/share/code-server/User/settings.json";
    expect(codeServer?.paths).toContain(settingsPath);
    const step = codeServer?.build.find((s) => s.includes(settingsPath));
    if (!step) throw new Error("no settings step");

    const home = mkdtempSync(join(tmpdir(), "code-server-settings-"));
    try {
      const run = Bun.spawnSync(["bash", "-c", step], {
        env: { ...process.env, HOME: home },
      });
      expect(run.exitCode).toBe(0);
      const written = readFileSync(
        join(home, ".local/share/code-server/User/settings.json"),
        "utf8",
      );
      expect(JSON.parse(written)).toMatchObject({
        "security.workspace.trust.enabled": false,
        "telemetry.telemetryLevel": "off",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("findToolboxSuggestion is undefined for an unknown id", () => {
    expect(findToolboxSuggestion("nope")).toBeUndefined();
    expect(findToolboxSuggestion(undefined)).toBeUndefined();
  });

  test("pendingSuggestions drops the ones whose slug the org has", () => {
    expect(pendingSuggestions([]).map((s) => s.id)).toEqual([
      "opencode",
      "pi-cliproxy",
      "code-server",
    ]);
    expect(
      pendingSuggestions([{ slug: "opencode" }, { slug: "custom" }]).map(
        (s) => s.id,
      ),
    ).toEqual(["pi-cliproxy", "code-server"]);
  });

  test("missingSecrets lists the secrets the org lacks", () => {
    const pi = findToolboxSuggestion("pi-cliproxy");
    if (!pi) throw new Error("missing pi suggestion");
    expect(missingSecrets(pi, [])).toEqual(["CLIPROXY_KEY"]);
    expect(missingSecrets(pi, [{ name: "CLIPROXY_KEY" }])).toEqual([]);
  });
});
