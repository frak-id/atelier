/**
 * The provenance detection behind the config plane's file/env lock: a key is
 * locked (read-only, live) only when the operator explicitly set it via the
 * mounted config file or an env var — not when it merely has a schema default.
 * Regression guard for the bug where file-provided config surfaced as the
 * hard-coded default and never locked.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasConfigPath, loadProvidedConfig } from "@frak/atelier-shared";

function writeConfig(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-config-"));
  const file = join(dir, "sandbox.config.json");
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

describe("hasConfigPath", () => {
  const obj = {
    kubernetes: { registryUrl: "zot.zot.svc:5000", storageClass: "" },
    imageBuilder: { tls: { secretName: "s" } },
  };

  test("true for a present nested path (even empty string)", () => {
    expect(hasConfigPath(obj, "kubernetes.registryUrl")).toBe(true);
    expect(hasConfigPath(obj, "kubernetes.storageClass")).toBe(true);
    expect(hasConfigPath(obj, "imageBuilder.tls.secretName")).toBe(true);
  });

  test("false for an absent path", () => {
    expect(hasConfigPath(obj, "kubernetes.volumeSnapshotClass")).toBe(false);
    expect(hasConfigPath(obj, "imageBuilder.kind")).toBe(false);
    expect(hasConfigPath(obj, "jobs.concurrency")).toBe(false);
  });
});

describe("loadProvidedConfig", () => {
  test("reports only operator-set file paths, not schema defaults", () => {
    const file = writeConfig({
      kubernetes: {
        registryUrl: "zot.zot.svc:5000",
        defaultVolumeSize: "20Gi",
      },
      imageBuilder: { kind: "buildkit" },
    });
    const provided = loadProvidedConfig({ configFile: file, skipEnv: true });

    // Explicitly set → present (these lock + surface their real value).
    expect(hasConfigPath(provided, "kubernetes.registryUrl")).toBe(true);
    expect(hasConfigPath(provided, "kubernetes.defaultVolumeSize")).toBe(true);
    expect(hasConfigPath(provided, "imageBuilder.kind")).toBe(true);

    // Not set → absent (these stay editable from the console).
    expect(hasConfigPath(provided, "imageBuilder.image")).toBe(false);
    expect(hasConfigPath(provided, "kubernetes.storageClass")).toBe(false);
    expect(hasConfigPath(provided, "jobs.concurrency")).toBe(false);
  });

  test("empty when the operator provides neither file nor env", () => {
    const provided = loadProvidedConfig({
      configFile: "/nonexistent/atelier.json",
      skipEnv: true,
    });
    expect(hasConfigPath(provided, "kubernetes.registryUrl")).toBe(false);
  });
});
