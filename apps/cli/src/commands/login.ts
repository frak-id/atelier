/** `atelier login` / `logout` — browser OAuth via a local loopback listener,
 * then mint a persistent `atl_` API key (the `gh auth login` pattern).
 *
 * Flow: start a throwaway HTTP server on 127.0.0.1:<random>, open the server's
 * `/auth/github?cli=<loopback>`, and wait for the callback to hand back a JWT.
 * Trade the JWT for a long-lived API key via `POST /api/api-keys`, store it,
 * and verify with `/api/me`.
 */
import { hostname } from "node:os";
import type { Command } from "commander";
import pc from "picocolors";
import { createClient, unwrap } from "../client.ts";
import type { CliConfig } from "../config.ts";
import { clearConfig, loadConfig, saveConfig } from "../config.ts";
import type { Ctx } from "../context.ts";
import { line } from "../output.ts";
import * as ui from "../ui.ts";
import { openInBrowser } from "../util.ts";
import { runInit } from "./config.ts";

const CALLBACK_HTML = (ok: boolean) =>
  `<!doctype html><meta charset="utf-8"><title>atelier</title>` +
  `<body style="font:16px system-ui;padding:3rem;text-align:center">` +
  `<h1>${ok ? "✓ Logged in" : "✗ Login failed"}</h1>` +
  `<p>${ok ? "You can now close this tab and return to the terminal." : "Return to the terminal and try again."}</p>`;

const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

/** Open a browser session against `baseUrl` and resolve to a JWT. */
async function browserAuth(
  baseUrl: string,
  noBrowser: boolean,
): Promise<string> {
  let resolveToken!: (t: string) => void;
  let rejectToken!: (e: Error) => void;
  const tokenPromise = new Promise<string>((res, rej) => {
    resolveToken = res;
    rejectToken = rej;
  });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") {
        return new Response("not found", { status: 404 });
      }
      const token = url.searchParams.get("token");
      const err = url.searchParams.get("login_error");
      if (token) {
        resolveToken(token);
        return new Response(CALLBACK_HTML(true), {
          headers: { "content-type": "text/html" },
        });
      }
      rejectToken(new Error(err ?? "no token in callback"));
      return new Response(CALLBACK_HTML(false), {
        status: 400,
        headers: { "content-type": "text/html" },
      });
    },
  });

  const redirectUri = `http://127.0.0.1:${server.port}/callback`;
  const authUrl = `${baseUrl}/auth/github?cli=${encodeURIComponent(redirectUri)}`;

  if (noBrowser) {
    line(`Open this URL to sign in:\n  ${pc.cyan(authUrl)}`);
  } else {
    line(`Opening your browser to sign in…`);
    line(pc.dim(`  ${authUrl}`));
    openInBrowser(authUrl);
  }

  const timeout = new Promise<never>((_, rej) =>
    setTimeout(
      () => rej(new Error("timed out waiting for browser login")),
      LOGIN_TIMEOUT_MS,
    ),
  );
  try {
    return await Promise.race([tokenPromise, timeout]);
  } finally {
    // Keep the listener up briefly so the browser fully receives the
    // "you can close this tab" response before we tear the socket down.
    setTimeout(() => server.stop(true), 500);
  }
}

interface LoginOpts {
  url?: string;
  browser?: boolean; // commander sets `browser:false` for --no-browser
  name?: string;
}

export async function runLogin(opts: LoginOpts): Promise<void> {
  ui.intro(pc.cyan("atelier login"));
  const current = loadConfig();
  const baseUrl =
    opts.url?.trim() ||
    (
      await ui.text({
        message: "Server base URL",
        placeholder: "https://atelier.example.com",
        initialValue: current.baseUrl,
        validate: (v) =>
          /^https?:\/\//.test(v.trim())
            ? undefined
            : "must start with http:// or https://",
      })
    ).trim();
  const normalized = baseUrl.replace(/\/+$/, "");

  const s = ui.spinner();
  s.start("Waiting for browser sign-in…");
  let jwt: string;
  try {
    jwt = await browserAuth(normalized, opts.browser === false);
  } catch (err) {
    s.stop(pc.red(err instanceof Error ? err.message : String(err)), 1);
    ui.outro("Not logged in.");
    process.exitCode = 1;
    return;
  }
  s.message("Minting API key…");

  // Trade the short-lived JWT for a durable API key, then store only the key.
  const jwtClient = createClient({ baseUrl: normalized, apiKey: jwt });
  const keyName = opts.name?.trim() || `cli@${hostname()}`;
  const { rawKey } = unwrap(
    await jwtClient.api["api-keys"].post({ name: keyName }),
  );

  const cfg: CliConfig = { baseUrl: normalized, apiKey: rawKey };
  const me = unwrap(await createClient(cfg).api.me.get());
  const path = saveConfig(cfg);
  s.stop(pc.green(`Logged in as ${me.username}`));
  ui.outro(`Saved key "${keyName}" to ${pc.dim(path)}`);
}

/** Best-effort: revoke the stored key on the server, then wipe local config. */
async function runLogout(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.apiKey?.startsWith("atl_")) {
    try {
      const client = createClient(cfg);
      const keys = unwrap(await client.api["api-keys"].get());
      const prefix = cfg.apiKey.slice(0, 8);
      const match = keys.find((k) => k.keyPrefix === prefix);
      if (match) await client.api["api-keys"]({ id: match.id }).delete();
    } catch {
      // Server unreachable or key already gone — local wipe still proceeds.
    }
  }
  clearConfig();
  line("Logged out.");
}

/** Present the first-run choice: browser login or paste a key. */
export async function runSetup(): Promise<void> {
  const method = await ui.select<"login" | "paste">({
    message: "Set up atelier",
    options: [
      { value: "login", label: "Log in with your browser (recommended)" },
      { value: "paste", label: "Paste an API key" },
    ],
  });
  return method === "login" ? runLogin({}) : runInit();
}

export function registerAuth(program: Command, _ctx: Ctx): void {
  program
    .command("login")
    .description("Log in via your browser and store an API key")
    .option("--url <baseUrl>", "server base URL")
    .option("--no-browser", "print the login URL instead of opening a browser")
    .option("--name <name>", "name for the minted API key")
    .action((opts: LoginOpts) => {
      if (!ui.isInteractive() && opts.browser !== false) {
        line(
          pc.red(
            "login needs a terminal; use --no-browser on a headless host, or `config set key <atl_…>`",
          ),
        );
        process.exit(1);
      }
      return runLogin(opts);
    });

  program
    .command("logout")
    .description("Revoke the stored API key and clear local config")
    .action(() => runLogout());
}
