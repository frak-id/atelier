/**
 * The CLI config file: the canonical `{ current, contexts }` shape loads; the
 * old flat `{ baseUrl, apiKey }` file is no longer read and points the user
 * at `atelier login`.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

// `configPath` comes from `homedir()` at import time, and Bun's `homedir()`
// ignores $HOME: mock it so the test can never touch the real ~/.atelier.
const home = mkdtempSync(join(os.tmpdir(), "atelier-cli-config-"));
mock.module("node:os", () => ({ ...os, homedir: () => home }));

let cfg: typeof import("./config.ts");

beforeAll(async () => {
  delete process.env.ATELIER_API_URL;
  delete process.env.ATELIER_API_KEY;
  cfg = await import("./config.ts");
  if (!cfg.configPath.startsWith(home)) {
    throw new Error(`refusing to run: configPath ${cfg.configPath} is real`);
  }
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

async function writeRaw(data: unknown): Promise<void> {
  await Bun.write(cfg.configPath, JSON.stringify(data));
}

describe("CLI config", () => {
  test("lives under the home dir", () => {
    expect(cfg.configPath).toBe(join(home, ".atelier", "config.json"));
  });

  test("loads the current context", async () => {
    await writeRaw({
      current: "prod",
      contexts: {
        prod: { baseUrl: "https://atelier.example/", apiKey: "atl_prod" },
      },
    });
    expect(cfg.resolveConfig()).toEqual({
      baseUrl: "https://atelier.example",
      apiKey: "atl_prod",
    });
  });

  test("the old flat file is not read and asks for a fresh login", async () => {
    await writeRaw({ baseUrl: "https://old.example", apiKey: "atl_old" });
    expect(cfg.loadConfig().apiKey).toBe("");
    expect(() => cfg.resolveConfig()).toThrow(/old flat format/);
  });

  test("any write replaces the old flat file", async () => {
    await writeRaw({ baseUrl: "https://old.example", apiKey: "atl_old" });
    cfg.saveConfig({ baseUrl: "https://new.example", apiKey: "atl_new" });
    const raw = JSON.parse(await Bun.file(cfg.configPath).text());
    expect(raw).toEqual({
      current: "default",
      contexts: {
        default: { baseUrl: "https://new.example", apiKey: "atl_new" },
      },
    });
  });
});
