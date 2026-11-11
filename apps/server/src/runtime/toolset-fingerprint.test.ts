/**
 * The toolset fingerprint decides whether a refresh saves a new version, so
 * it must move on every change a capture would save and stay put on
 * everything a capture drops (timestamps, excluded secret files).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../shared/errors.ts";
import {
  fingerprintScript,
  homeRelative,
  parseFingerprint,
} from "./toolset-fingerprint.ts";

describe("homeRelative", () => {
  test("accepts the agent's home-relative spellings", () => {
    expect(homeRelative("~/.local/bin")).toBe(".local/bin");
    expect(homeRelative("$HOME/.pi/agent/")).toBe(".pi/agent");
    expect(homeRelative("/home/dev/.bashrc")).toBe(".bashrc");
    expect(homeRelative(".config/x")).toBe(".config/x");
  });

  test("refuses paths outside the home, '..' and the whole home", () => {
    for (const path of ["/etc/passwd", "~/../root", "~/", "~", "/home/dev"]) {
      expect(() => homeRelative(path)).toThrow(ValidationError);
    }
  });
});

describe("parseFingerprint", () => {
  test("only a sha256 hex line is a fingerprint", () => {
    const hex = "a".repeat(64);
    expect(parseFingerprint(`${hex}\n`)).toBe(hex);
    expect(parseFingerprint("")).toBeUndefined();
    expect(parseFingerprint("not a hash")).toBeUndefined();
  });
});

describe("fingerprintScript", () => {
  test("quotes paths so a hostile path stays one argument", () => {
    const script = fingerprintScript(["~/it's here; rm -rf x"]);
    expect(script).toContain(`find 'it'\\''s here; rm -rf x' `);
  });
});

/** GNU find (`-printf`) and coreutils: present on Linux CI and in every
 * sandbox image, usually absent on macOS. */
function hasGnuTools(): boolean {
  const probe = spawnSync(
    "bash",
    ["-c", "find --version && sha256sum --version >/dev/null"],
    { encoding: "utf8" },
  );
  return probe.status === 0 && probe.stdout.includes("GNU findutils");
}

describe.skipIf(!hasGnuTools())("fingerprintScript (GNU tools)", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  function setup(): string {
    home = mkdtempSync(join(tmpdir(), "atelier-fingerprint-"));
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    mkdirSync(join(home, ".pi/agent"), { recursive: true });
    writeFileSync(join(home, ".local/bin/tool"), "v1");
    chmodSync(join(home, ".local/bin/tool"), 0o755);
    writeFileSync(join(home, ".pi/agent/settings.json"), "{}");
    writeFileSync(join(home, ".pi/agent/auth.json"), "token-1");
    symlinkSync("tool", join(home, ".local/bin/alias"));
    return home;
  }

  function hash(dir: string): string {
    const script = fingerprintScript(
      ["~/.local/bin", "~/.pi/agent", "~/.missing"],
      dir,
    );
    const out = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(out.status).toBe(0);
    const value = parseFingerprint(out.stdout);
    if (!value) throw new Error(`no fingerprint: ${out.stdout}${out.stderr}`);
    return value;
  }

  test("stable when nothing a capture saves changed", () => {
    const dir = setup();
    const first = hash(dir);
    expect(hash(dir)).toBe(first);
    // Timestamps are normalized away by the artifact.
    utimesSync(join(dir, ".local/bin/tool"), new Date(0), new Date(0));
    // Excluded secret files never reach a capture.
    writeFileSync(join(dir, ".pi/agent/auth.json"), "token-2");
    expect(hash(dir)).toBe(first);
  });

  test("drops secret files but keeps a directory with the same name", () => {
    const dir = setup();
    // `@anthropic-ai/sdk` ships its auth module as `lib/credentials/`.
    mkdirSync(join(dir, ".local/bin/credentials"));
    writeFileSync(join(dir, ".local/bin/credentials/index.js"), "v1");
    const first = hash(dir);
    writeFileSync(join(dir, ".pi/agent/credentials"), "secret");
    expect(hash(dir)).toBe(first);
    writeFileSync(join(dir, ".local/bin/credentials/index.js"), "v2");
    expect(hash(dir)).not.toBe(first);
  });

  test("hashes key files, so a CA bundle update is a change", () => {
    const dir = setup();
    // The capture keeps a certificate bundle such as certifi's cacert.pem.
    writeFileSync(join(dir, ".local/bin/cacert.pem"), "cert-1");
    const first = hash(dir);
    writeFileSync(join(dir, ".pi/agent/.credentials.json"), "token");
    expect(hash(dir)).toBe(first);
    writeFileSync(join(dir, ".local/bin/cacert.pem"), "cert-2");
    expect(hash(dir)).not.toBe(first);
  });

  test("moves on content, mode, symlink target and new files", () => {
    const dir = setup();
    const first = hash(dir);

    writeFileSync(join(dir, ".local/bin/tool"), "v2");
    const afterContent = hash(dir);
    expect(afterContent).not.toBe(first);

    chmodSync(join(dir, ".local/bin/tool"), 0o700);
    const afterMode = hash(dir);
    expect(afterMode).not.toBe(afterContent);

    unlinkSync(join(dir, ".local/bin/alias"));
    symlinkSync("other", join(dir, ".local/bin/alias"));
    const afterLink = hash(dir);
    expect(afterLink).not.toBe(afterMode);

    mkdirSync(join(dir, ".missing"));
    expect(hash(dir)).not.toBe(afterLink);
  });
});
