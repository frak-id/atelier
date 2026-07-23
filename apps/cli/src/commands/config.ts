/** `atelier config` — local CLI setup (base URL + API key + doctor) and, under
 * `config server`, the server-wide runtime config plane (`/api/config`). */
import type { Command } from "commander";
import pc from "picocolors";
import { createClient, unwrap } from "../client.ts";
import {
  type CliConfig,
  clearConfig,
  loadConfig,
  saveConfig,
  updateConfig,
} from "../config.ts";
import type { Ctx } from "../context.ts";
import {
  fail,
  line,
  maskKey,
  ok,
  printJson,
  statusColor,
  table,
} from "../output.ts";
import { resolveSshRegistration } from "../ssh-keys.ts";
import * as ui from "../ui.ts";

/** SSH readiness: which local keys exist and whether any is registered on the
 * server (the prerequisite for `atelier ssh`). Only meaningful once authed. */
const probeSsh = (cfg: CliConfig) => resolveSshRegistration(createClient(cfg));

/** Probe a config: connectivity (`/health`, no auth) then auth (`/api/config`,
 * needs a valid Bearer). Returns a per-check verdict for `doctor`. */
async function probe(cfg: CliConfig): Promise<{
  reachable: boolean;
  authed: boolean;
  detail: string;
}> {
  const api = createClient(cfg);
  try {
    const health = await api.health.get();
    if (health.error) {
      return {
        reachable: false,
        authed: false,
        detail: `HTTP ${health.status}`,
      };
    }
  } catch (err) {
    return {
      reachable: false,
      authed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!cfg.apiKey)
    return { reachable: true, authed: false, detail: "no API key" };
  const res = await api.api.config.get();
  if (res.error) {
    const msg =
      res.error.status === 401
        ? "invalid/expired API key"
        : `HTTP ${res.error.status}`;
    return { reachable: true, authed: false, detail: msg };
  }
  return { reachable: true, authed: true, detail: "ok" };
}

export async function runInit(): Promise<void> {
  const current = loadConfig();
  ui.intro(pc.cyan("atelier config"));
  const baseUrl = await ui.text({
    message: "Server base URL",
    placeholder: "http://localhost:4000",
    initialValue: current.baseUrl,
    validate: (v) =>
      /^https?:\/\//.test(v.trim())
        ? undefined
        : "must start with http:// or https://",
  });
  const apiKey = await ui.password({
    message: "API key (atl_… / JWT from the console or POST /api-keys)",
    validate: (v) => (v.trim() ? undefined : "required"),
  });

  const cfg: CliConfig = { baseUrl: baseUrl.trim(), apiKey: apiKey.trim() };
  const s = ui.spinner();
  s.start("Verifying…");
  const verdict = await probe(cfg);
  if (!verdict.reachable) {
    s.stop(pc.red(`Cannot reach ${cfg.baseUrl}: ${verdict.detail}`), 1);
    const proceed = await ui.confirm({
      message: "Save anyway?",
      initialValue: false,
    });
    if (!proceed) {
      ui.outro("Not saved.");
      return;
    }
  } else if (!verdict.authed) {
    s.stop(pc.red(`Auth failed: ${verdict.detail}`), 1);
    const proceed = await ui.confirm({
      message: "Save anyway?",
      initialValue: false,
    });
    if (!proceed) {
      ui.outro("Not saved.");
      return;
    }
  } else {
    s.stop(pc.green("Connected and authenticated."));
  }
  const path = saveConfig(cfg);
  ui.outro(`Saved to ${pc.dim(path)}`);
}

async function runDoctor(json: boolean): Promise<void> {
  const cfg = loadConfig();
  const verdict = await probe(cfg);
  // The SSH check only makes sense once we can talk to the server as the user.
  const ssh = verdict.authed ? await probeSsh(cfg).catch(() => null) : null;
  if (json) {
    printJson({
      configPath: cfg.configPath,
      context: cfg.context,
      contexts: cfg.contexts,
      baseUrl: cfg.baseUrl,
      baseUrlSource: cfg.baseUrlSource,
      apiKeyConfigured: Boolean(cfg.apiKey),
      apiKeySource: cfg.apiKeySource,
      reachable: verdict.reachable,
      authenticated: verdict.authed,
      detail: verdict.detail,
      ssh: ssh
        ? {
            localKeyCount: ssh.localKeys.length,
            registered: Boolean(ssh.registered),
            registeredFingerprint: ssh.registered?.fingerprint ?? null,
          }
        : null,
    });
    return;
  }
  line(pc.bold("atelier doctor"));
  line(`  config file   ${pc.dim(cfg.configPath)}`);
  line(
    `  context       ${cfg.context} ${pc.dim(`(${cfg.contexts.length} total)`)}`,
  );
  line(`  base URL      ${cfg.baseUrl} ${pc.dim(`(${cfg.baseUrlSource})`)}`);
  line(
    `  API key       ${cfg.apiKey ? maskKey(cfg.apiKey) : pc.red("unset")} ${pc.dim(`(${cfg.apiKeySource})`)}`,
  );
  line(
    `  ${ok(verdict.reachable)} reachable    ${pc.dim(verdict.reachable ? cfg.baseUrl : verdict.detail)}`,
  );
  line(
    `  ${ok(verdict.authed)} authenticated ${pc.dim(verdict.authed ? "" : verdict.detail)}`,
  );
  if (ssh) {
    const hasLocal = ssh.localKeys.length > 0;
    line(
      `  ${ok(hasLocal)} local ssh key ${pc.dim(hasLocal ? `${ssh.localKeys.length} in ~/.ssh` : "none found")}`,
    );
    line(
      `  ${ok(Boolean(ssh.registered))} ssh registered ${pc.dim(ssh.registered ? ssh.registered.fingerprint : "no local key registered on server")}`,
    );
  }
  if (!verdict.reachable || !verdict.authed) {
    line("");
    line(pc.dim("Run `atelier config init` to fix."));
    process.exitCode = 1;
  } else if (ssh && !ssh.registered) {
    line("");
    line(pc.dim("Run `atelier ssh-key setup` to enable sandbox SSH."));
  }
}

export function registerConfig(program: Command, ctx: Ctx): void {
  const config = program
    .command("config")
    .description("Configure the CLI (base URL + API key) and check health")
    .action(async () => {
      // Bare `atelier config`: set up if empty, else show current state.
      const cur = loadConfig();
      if (!cur.apiKey && ui.isInteractive()) return runInit();
      return runDoctor(ctx.json);
    });

  config
    .command("init")
    .description("Interactively set base URL + API key and verify")
    .action(() => {
      if (!ui.isInteractive()) {
        fail(
          "config init needs an interactive terminal; use `config set` in scripts",
        );
      }
      return runInit();
    });

  config
    .command("doctor")
    .description("Check connectivity + authentication")
    .action(() => runDoctor(ctx.json));

  config
    .command("show")
    .description("Print the resolved config (API key redacted)")
    .action(() => {
      const cur = loadConfig();
      if (ctx.json) {
        return printJson({
          configPath: cur.configPath,
          context: cur.context,
          contexts: cur.contexts,
          baseUrl: cur.baseUrl,
          baseUrlSource: cur.baseUrlSource,
          apiKey: cur.apiKey ? maskKey(cur.apiKey) : null,
          apiKeySource: cur.apiKeySource,
        });
      }
      line(
        `context    ${cur.context} ${pc.dim(`(${cur.contexts.length} total)`)}`,
      );
      line(`base URL   ${cur.baseUrl} ${pc.dim(`(${cur.baseUrlSource})`)}`);
      line(
        `API key    ${maskKey(cur.apiKey)} ${pc.dim(`(${cur.apiKeySource})`)}`,
      );
      line(`config     ${pc.dim(cur.configPath)}`);
    });

  config
    .command("path")
    .description("Print the config file path")
    .action(() => line(loadConfig().configPath));

  config
    .command("set <key> <value>")
    .description("Set a local config value (key: url | key)")
    .action((key: string, value: string) => {
      if (key === "url" || key === "baseUrl") {
        const path = updateConfig({ baseUrl: value });
        line(`base URL set (${pc.dim(path)})`);
      } else if (key === "key" || key === "apiKey") {
        const path = updateConfig({ apiKey: value });
        line(`API key set (${pc.dim(path)})`);
      } else {
        fail(`unknown config key "${key}" (expected url | key)`);
      }
    });

  config
    .command("get <key>")
    .description("Print a local config value (key: url | key)")
    .action((key: string) => {
      const cur = loadConfig();
      if (key === "url" || key === "baseUrl") line(cur.baseUrl);
      else if (key === "key" || key === "apiKey") line(cur.apiKey || "");
      else fail(`unknown config key "${key}" (expected url | key)`);
    });

  config
    .command("reset")
    .description("Delete the local config file")
    .action(() => {
      clearConfig();
      line("config reset");
    });

  // ── server config plane (/api/config) ────────────────────────────────────
  const server = config
    .command("server")
    .description("Server-wide runtime config knobs (/api/config)");

  server
    .command("ls")
    .description("List server config keys with values + defaults")
    .action(async () => {
      const entries = unwrap(await ctx.api().api.config.get());
      if (ctx.json) return printJson(entries);
      table(
        ["", "key", "value", "default", "type"],
        entries.map((e) => [
          e.isDefault ? " " : pc.yellow("*"),
          e.key,
          statusColor(String(e.value)),
          pc.dim(String(e.default)),
          pc.dim(e.type),
        ]),
      );
    });

  server
    .command("get <key>")
    .description("Print a server config value")
    .action(async (key: string) => {
      const entries = unwrap(await ctx.api().api.config.get());
      const entry = entries.find((e) => e.key === key);
      if (!entry) fail(`unknown server config key "${key}"`);
      if (ctx.json) return printJson(entry);
      line(String(entry.value));
    });

  server
    .command("set <key> <value>")
    .description("Set a server config value (true|false or a number)")
    .action(async (key: string, raw: string) => {
      const value: boolean | number =
        raw === "true"
          ? true
          : raw === "false"
            ? false
            : Number.isFinite(Number(raw))
              ? Number(raw)
              : fail("value must be true|false or a number");
      const result = unwrap(await ctx.api().api.config({ key }).put({ value }));
      if (ctx.json) return printJson(result);
      line(`${key} = ${JSON.stringify(result.value)}`);
    });
}
