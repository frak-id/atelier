/** Persisted preferences for `atelier local` that aren't a `{ baseUrl, apiKey }`
 * context — currently just the git-auth choice for injecting the host's
 * GitHub token into local sandboxes. Lives at `~/.atelier/local.json`,
 * separate from `config.json` so a corrupt/missing file here never affects
 * context resolution. */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atelierDir } from "./config.ts";

export interface LocalSettings {
  /** How `local up` resolves the GitHub token injected into sandboxes. */
  gitAuth?: "gh" | "env" | "pat" | "none";
  /** Personal access token, when gitAuth is "pat". */
  pat?: string;
  /** Set once the user has confirmed the "your host token is passed into
   * sandboxes, an agent there can read it" notice — skips re-asking. */
  tokenConsent?: boolean;
}

const localSettingsPath = join(atelierDir, "local.json");

/** Read `~/.atelier/local.json`, tolerant of a missing or corrupt file. */
export function loadLocalSettings(): LocalSettings {
  try {
    return JSON.parse(readFileSync(localSettingsPath, "utf8")) as LocalSettings;
  } catch {
    return {};
  }
}

/** Merge `patch` into the persisted settings and write (0600 — may hold a PAT). */
export function saveLocalSettings(patch: Partial<LocalSettings>): void {
  const next = { ...loadLocalSettings(), ...patch };
  mkdirSync(dirname(localSettingsPath), { recursive: true });
  writeFileSync(localSettingsPath, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  });
  // `writeFileSync`'s mode only applies on creation; enforce it every write
  // since this file can hold a raw PAT.
  chmodSync(localSettingsPath, 0o600);
}
