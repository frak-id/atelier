/** `atelier local` — bootstrap a self-hosted server on your machine via Docker,
 * so you can drive sandboxes without a hosted deployment.
 *
 * `up` runs the `atelier-server` image with:
 *   - `--network host` so the Docker runtime backend (which dials sandboxes at
 *     `127.0.0.1:<published>`) can reach the sibling containers it spawns;
 *   - the Docker socket mounted, so the server can `docker run` those siblings;
 *   - `ATELIER_SERVER_MODE=local` — real runtime (so the Docker backend
 *     actually drives sandboxes) but auth is bypassed (any token maps to a
 *     single local user, no GitHub OAuth app) — plus
 *     `ATELIER_RUNTIME_BACKEND=docker`;
 *   - a named volume for the sqlite DB at `/data`.
 * It then waits for `/health` and points a `local` context at it.
 *
 * Host networking is first-class on Linux and OrbStack; on Docker Desktop pass
 * `--network bridge` and reach the API on the mapped port (sandbox agent
 * dialing may need Linux — mirrors the DockerBackend's own constraints).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { createClient } from "../client.ts";
import { atelierDir, loadConfig, upsertContext } from "../config.ts";
import type { Ctx } from "../context.ts";
import { loadLocalSettings, saveLocalSettings } from "../local-settings.ts";
import { fail, line, ok, printJson } from "../output.ts";
import { runCapture, runInherit } from "../proc.ts";
import * as ui from "../ui.ts";

const GIT_AUTH_MODES = ["gh", "env", "pat", "none", "ask"] as const;
type GitAuthMode = (typeof GIT_AUTH_MODES)[number];

const GIT_AUTH_CONSENT_NOTE =
  "The token is injected into sandboxes so agents can clone/push your " +
  "private repos. It's a transient credential (scrubbed before any " +
  "snapshot), but an AI agent running in the sandbox can read — and could " +
  "exfiltrate — it.";

const CONTAINER = "atelier-local-server";
const VOLUME = "atelier-local-data";
const CONTEXT = "local";
/** nginx sidecar that serves the console SPA + reverse-proxies the server. */
const CONSOLE_CONTAINER = "atelier-local-console";
const DEFAULT_CONSOLE_PORT = "8080";
/** The three images `local up` runs. The tag is picked by the release channel
 * (`latest` by default, or `nightly` for the bleeding-edge CI build). */
const SERVER_IMAGE_REPO = "ghcr.io/frak-id/atelier-server";
const CONSOLE_IMAGE_REPO = "ghcr.io/frak-id/atelier-console";
/** Prebuilt public base image new sandboxes boot from (agent baked in). */
const SANDBOX_IMAGE_REPO = "ghcr.io/frak-id/atelier-dev-base";
const DEFAULT_CHANNEL = "latest";
const DOCKER_SOCK = "/var/run/docker.sock";

/** Resolve the server + console + sandbox image refs for a run. Explicit
 * --image / --console-image / --sandbox-image always win; otherwise --nightly
 * flips all three to the `nightly` tag together, keeping them in lockstep. */
function resolveImages(opts: {
  image?: string;
  consoleImage?: string;
  sandboxImage?: string;
  nightly?: boolean;
}): { image: string; consoleImage: string; sandboxImage: string } {
  const channel = opts.nightly ? "nightly" : DEFAULT_CHANNEL;
  return {
    image: opts.image ?? `${SERVER_IMAGE_REPO}:${channel}`,
    consoleImage: opts.consoleImage ?? `${CONSOLE_IMAGE_REPO}:${channel}`,
    sandboxImage: opts.sandboxImage ?? `${SANDBOX_IMAGE_REPO}:${channel}`,
  };
}

/** Generate the console's nginx config. Mirrors infra/nginx/console.conf but
 * with the listen port + server upstream parameterized, so a custom --port /
 * --console-port (or bridge networking, where the server is reached via
 * host.docker.internal instead of loopback) all work. Written to disk and
 * bind-mounted over the image's baked config. */
function consoleConf(
  listenPort: number,
  upstreamHost: string,
  serverPort: number,
): string {
  return `map $http_upgrade $connection_upgrade { default upgrade; '' ''; }
server {
    listen ${listenPort};
    server_name _;
    root /usr/share/nginx/html;
    index index.html;
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 256;
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    location ~ ^/(v1|api|sessions|auth|health|mcp|swagger)(/|$) {
        proxy_pass http://${upstreamHost}:${serverPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
    location / {
        try_files $uri /index.html;
    }
}
`;
}

/** Container run-state for `name`: running, stopped, or absent. */
async function runState(
  name: string,
): Promise<"running" | "stopped" | "absent"> {
  const res = await docker(["inspect", "-f", "{{.State.Running}}", name]);
  if (res.code !== 0) return "absent";
  return res.stdout.trim() === "true" ? "running" : "stopped";
}

/** Boot the console container: serves the SPA and reverse-proxies the
 * server-owned paths to the server so the browser uses one same-origin URL
 * (required for the httpOnly session cookie). Returns the browser URL. */
async function startConsole(
  opts: UpOpts,
  serverPort: number,
  consoleImage: string,
): Promise<string> {
  const consolePort = Number(opts.consolePort ?? DEFAULT_CONSOLE_PORT);
  if (!Number.isFinite(consolePort)) fail("--console-port must be a number");
  const hostNet = opts.network === "host";
  // On a bridge network the server isn't on loopback; reach it via the host.
  const upstreamHost = hostNet ? "127.0.0.1" : "host.docker.internal";
  mkdirSync(atelierDir, { recursive: true });
  const confPath = join(atelierDir, "console.conf");
  writeFileSync(confPath, consoleConf(consolePort, upstreamHost, serverPort));

  const s = ui.spinner();
  s.start("Starting console\u2026");
  const state = await runState(CONSOLE_CONTAINER);
  if (state === "running") {
    s.stop("Console already running");
  } else if (state === "stopped") {
    // Config may have changed (ports) — recreate rather than plain start.
    await docker(["rm", "-f", CONSOLE_CONTAINER]);
    await runConsole(opts, consolePort, hostNet, confPath, consoleImage);
    s.stop("Console started");
  } else {
    await runConsole(opts, consolePort, hostNet, confPath, consoleImage);
    s.stop("Console started");
  }
  return `http://127.0.0.1:${consolePort}`;
}

async function runConsole(
  opts: UpOpts,
  consolePort: number,
  hostNet: boolean,
  confPath: string,
  consoleImage: string,
): Promise<void> {
  const runArgs = [
    "run",
    "-d",
    "--name",
    CONSOLE_CONTAINER,
    "--restart",
    "unless-stopped",
    "--network",
    opts.network,
    "-v",
    `${confPath}:/etc/nginx/conf.d/default.conf:ro`,
  ];
  // Bridge networking can't bind the host port implicitly, and the server is
  // only reachable via the host gateway alias — publish + wire both.
  if (!hostNet) {
    runArgs.push(
      "-p",
      `${consolePort}:${consolePort}`,
      "--add-host",
      "host.docker.internal:host-gateway",
    );
  }
  runArgs.push(consoleImage);
  const res = await docker(runArgs);
  if (res.code !== 0) fail(res.stderr.trim() || "docker run failed (console)");
}

/** Run `docker <args>`, capturing stdout/stderr + exit code (never rejects).
 * `extraEnv` is merged into the child's environment (used to pass a secret via
 * the process env + `-e NAME` rather than argv, so it never shows in `ps`). */
const docker = (args: string[], extraEnv?: Record<string, string>) =>
  runCapture(["docker", ...args], extraEnv ? { env: extraEnv } : undefined);

/** Run `gh <args>`, capturing stdout/stderr + exit code (never rejects). Used
 * only to read a token, never to print it. */
const gh = (args: string[]) => runCapture(["gh", ...args]);

/** Best-effort `gh auth token` — undefined if `gh` is missing, unauthenticated,
 * or the call otherwise fails. Never throws, never prints the token. */
async function ghAuthToken(): Promise<string | undefined> {
  const res = await gh(["auth", "token"]);
  if (res.code !== 0) return undefined;
  const token = res.stdout.trim();
  return token || undefined;
}

function envGitToken(): string | undefined {
  return (
    process.env.ATELIER_GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    undefined
  );
}

/** Ask for consent before a resolved token is actually injected, unless the
 * user already opted in (persisted) or we're non-interactive (scripted use
 * implies consent — but still say so, once, without printing the token). */
async function ensureTokenConsent(): Promise<boolean> {
  if (loadLocalSettings().tokenConsent) return true;
  if (!ui.isInteractive()) {
    line(pc.dim("Injecting host GitHub token into local sandboxes."));
    return true;
  }
  const consented = await ui.confirm({
    message: `${GIT_AUTH_CONSENT_NOTE} Continue?`,
    initialValue: true,
  });
  if (consented) saveLocalSettings({ tokenConsent: true });
  return consented;
}

interface GitTokenResult {
  token: string | undefined;
  mode: GitAuthMode;
}

/** Gate a resolved token behind one-time consent (persisted). Declining
 * returns undefined — the caller proceeds without a token, not an error. */
async function gated(token: string): Promise<string | undefined> {
  return (await ensureTokenConsent()) ? token : undefined;
}

/** Prompt for and persist a pasted PAT; empty input aborts (no token). */
async function promptForPat(): Promise<string | undefined> {
  const pat = (
    await ui.password({ message: "GitHub personal access token" })
  ).trim();
  if (!pat) return undefined;
  saveLocalSettings({ pat });
  return pat;
}

/** Resolve the GitHub token (if any) to inject into local sandboxes as
 * ATELIER_GITHUB_TOKEN. Mode precedence: --git-auth flag > persisted
 * ~/.atelier/local.json choice > "ask". Never prints the token value. */
async function resolveGitToken(opts: UpOpts): Promise<GitTokenResult> {
  if (opts.gitAuth && !GIT_AUTH_MODES.includes(opts.gitAuth as GitAuthMode)) {
    fail(
      `--git-auth must be one of: ${GIT_AUTH_MODES.join("|")} (got "${opts.gitAuth}")`,
    );
  }
  const mode: GitAuthMode =
    (opts.gitAuth as GitAuthMode | undefined) ??
    loadLocalSettings().gitAuth ??
    "ask";

  if (mode === "none") return { token: undefined, mode };

  if (mode === "env") {
    const token = envGitToken();
    if (!token) {
      line(
        pc.dim(
          "--git-auth env: no ATELIER_GITHUB_TOKEN/GITHUB_TOKEN found — private repos won't clone.",
        ),
      );
      return { token: undefined, mode };
    }
    return { token: await gated(token), mode };
  }

  if (mode === "gh") {
    const token = await ghAuthToken();
    if (!token) {
      line(
        pc.dim(
          "--git-auth gh: no token from `gh auth token` — run `gh auth login`, or private repos won't clone.",
        ),
      );
      return { token: undefined, mode };
    }
    return { token: await gated(token), mode };
  }

  if (mode === "pat") {
    const stored = loadLocalSettings().pat;
    if (stored) return { token: await gated(stored), mode };
    if (!ui.isInteractive()) {
      line(
        pc.dim(
          "--git-auth pat: no stored token and not interactive — private repos won't clone.",
        ),
      );
      return { token: undefined, mode };
    }
    const pat = await promptForPat();
    return { token: pat ? await gated(pat) : undefined, mode };
  }

  // mode === "ask"
  if (!ui.isInteractive()) {
    // Scripted / non-TTY: NEVER inject an ambient credential without an
    // explicit choice. `ask` is the default, and auto-detecting here would
    // silently bake e.g. a CI runner's GITHUB_TOKEN into a long-lived
    // container. Default to no token; scripted callers opt in explicitly with
    // `--git-auth env|gh|pat`.
    line(
      pc.dim(
        "git auth: skipped (non-interactive) — pass --git-auth env|gh|pat to inject a token.",
      ),
    );
    return { token: undefined, mode };
  }

  // mode === "ask", interactive
  return chooseGitAuthInteractive();
}

type ChosenMode = Exclude<GitAuthMode, "ask">;

/** Interactive picker for the git-auth source: detects what's available (gh /
 * env), records the choice (+consent) to ~/.atelier/local.json, and resolves
 * the token for it. Shared by `up`'s ask-mode and the cockpit's GitHub-auth
 * menu. Assumes an interactive TTY. Never prints the token value. */
async function chooseGitAuthInteractive(): Promise<GitTokenResult> {
  const envToken = envGitToken();
  const ghToken = await ghAuthToken();
  const options: { value: ChosenMode; label: string; hint?: string }[] = [];
  if (ghToken) {
    options.push({
      value: "gh",
      label: "Use GitHub CLI token (gh auth token)",
      hint: "recommended — reuses your existing gh login",
    });
  }
  if (envToken) {
    options.push({
      value: "env",
      label: "Use ATELIER_GITHUB_TOKEN/GITHUB_TOKEN from your env",
    });
  }
  options.push(
    { value: "pat", label: "Paste a Personal Access Token" },
    { value: "none", label: "None — public repos only" },
  );

  const chosen = await ui.select<ChosenMode>({
    message: `Git auth for private repos in sandboxes? ${GIT_AUTH_CONSENT_NOTE}`,
    options,
  });
  // The selection itself is the consent (the note is in the prompt above), so
  // record it — otherwise `gated()` below would prompt a second time.
  saveLocalSettings(
    chosen === "none"
      ? { gitAuth: chosen }
      : { gitAuth: chosen, tokenConsent: true },
  );

  if (chosen === "none") return { token: undefined, mode: chosen };
  if (chosen === "env") {
    return {
      token: envToken ? await gated(envToken) : undefined,
      mode: chosen,
    };
  }
  if (chosen === "gh") {
    return { token: ghToken ? await gated(ghToken) : undefined, mode: chosen };
  }

  // chosen === "pat"
  const pat = await promptForPat();
  return { token: pat ? await gated(pat) : undefined, mode: chosen };
}

/** Cockpit panel (interactive `atelier`) for local mode's private-repo token.
 * Shows the current preference + whether a token resolves right now (never the
 * value), lets you change the source or reset it, and explains how it applies
 * (the running server keeps its booted token until recreated). */
export async function gitAuthMenu(): Promise<void> {
  const s = loadLocalSettings();
  const running = await runState(CONTAINER).catch(() => "absent" as const);
  ui.note(
    [
      `source: ${s.gitAuth ?? "ask (unset)"}`,
      `consent: ${s.tokenConsent ? "granted" : "not granted"}`,
      `stored PAT: ${s.pat ? "yes" : "no"}`,
      `local server: ${running}`,
    ].join("\n"),
    "GitHub auth (local)",
  );

  const configured = Boolean(s.gitAuth || s.pat || s.tokenConsent);
  const action = await ui.select<"change" | "reset" | "back">({
    message: "GitHub auth for private repos in local sandboxes",
    options: [
      {
        value: "change",
        label: "Change token source",
        hint: "gh / env / paste a PAT / none",
      },
      ...(configured
        ? [
            {
              value: "reset" as const,
              label: "Reset (clear source, stored PAT + consent)",
            },
          ]
        : []),
      { value: "back", label: pc.dim("Back") },
    ],
  });
  if (action === "back") return;
  if (action === "reset") {
    saveLocalSettings({
      gitAuth: undefined,
      pat: undefined,
      tokenConsent: undefined,
    });
    ui.note(
      "Cleared. New sandboxes get no token until you set a source again.",
    );
    return;
  }

  const { token, mode } = await chooseGitAuthInteractive();
  const applies =
    running === "running"
      ? "The running local server keeps its current token — recreate it to apply: `atelier local down` then `atelier local up`."
      : "Applies next time you run `atelier local up`.";
  ui.note(
    `${mode}: ${
      token
        ? "token resolved — private repos enabled"
        : "no token — public repos only"
    }\n${applies}`,
  );
}

async function ensureDocker(): Promise<void> {
  const res = await docker(["version", "--format", "{{.Server.Version}}"]);
  if (res.code !== 0) {
    fail(
      "Docker isn't available. Install Docker Desktop / OrbStack / a Linux " +
        "daemon and make sure `docker` is on your PATH.",
    );
  }
}

async function waitForHealth(
  baseUrl: string,
  timeoutMs = 45_000,
): Promise<boolean> {
  const client = createClient({ baseUrl, apiKey: "" });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await client.health.get();
      if (!res.error) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

interface UpOpts {
  image?: string;
  consoleImage?: string;
  sandboxImage?: string;
  nightly?: boolean;
  console?: boolean;
  consolePort?: string;
  gitAuth?: string;
  port: string;
  network: string;
  key: string;
}

async function up(ctx: Ctx, opts: UpOpts): Promise<void> {
  await ensureDocker();
  // Validate up-front so a bad --git-auth errors even when the container
  // already exists (the create-only resolveGitToken path is skipped then).
  if (opts.gitAuth && !GIT_AUTH_MODES.includes(opts.gitAuth as GitAuthMode)) {
    fail(
      `--git-auth must be one of: ${GIT_AUTH_MODES.join("|")} (got "${opts.gitAuth}")`,
    );
  }
  const port = Number(opts.port);
  if (!Number.isFinite(port)) fail("--port must be a number");
  const baseUrl = `http://127.0.0.1:${port}`;
  const { image, consoleImage, sandboxImage } = resolveImages(opts);

  const state = await runState(CONTAINER);
  let gitToken: string | undefined;
  let gitAuthMode: GitAuthMode = loadLocalSettings().gitAuth ?? "ask";
  if (state === "running") {
    line(pc.dim("Server already running."));
  } else if (state === "stopped") {
    const s = ui.spinner();
    s.start("Starting local server…");
    const res = await docker(["start", CONTAINER]);
    if (res.code !== 0) {
      s.stop("Failed to start", 1);
      fail(res.stderr.trim() || "docker start failed");
    }
    s.stop("Restarted existing container");
  } else {
    // Resolved before the spinner so an interactive prompt (ask mode) never
    // races a spinner re-render; only the create path needs this — an
    // existing container's env (including any injected token) is already
    // baked in, so the `start`/`running` branches above skip it entirely.
    ({ token: gitToken, mode: gitAuthMode } = await resolveGitToken(opts));

    const runArgs = [
      "run",
      "-d",
      "--name",
      CONTAINER,
      "--restart",
      "unless-stopped",
      "--network",
      opts.network,
      "-v",
      `${DOCKER_SOCK}:${DOCKER_SOCK}`,
      "-v",
      `${VOLUME}:/data`,
      "-e",
      "DATA_DIR=/data",
      "-e",
      "ATELIER_SERVER_MODE=local",
      "-e",
      "ATELIER_RUNTIME_BACKEND=docker",
      // Default new sandboxes to the prebuilt public base image so `local up`
      // needs no in-cluster builder/registry — the docker daemon just pulls it
      // (the agent is already baked in from GHCR at base-image build time).
      "-e",
      `ATELIER_DEFAULT_IMAGE=${sandboxImage}`,
      "-e",
      "ATELIER_SERVER_HOST=0.0.0.0",
      "-e",
      `ATELIER_SERVER_PORT=${port}`,
    ];
    // Pass the token by NAME only (`-e ATELIER_GITHUB_TOKEN`) and hand the
    // value through the child's env below, so the secret never appears in the
    // `docker run` argv (visible via `ps`/proc cmdline to other local users).
    if (gitToken) runArgs.push("-e", "ATELIER_GITHUB_TOKEN");
    // Bridge networking can't bind the host port implicitly — publish it.
    if (opts.network !== "host") runArgs.push("-p", `${port}:${port}`);
    runArgs.push(image);
    const s = ui.spinner();
    s.start("Starting container…");
    const res = await docker(
      runArgs,
      gitToken ? { ATELIER_GITHUB_TOKEN: gitToken } : undefined,
    );
    if (res.code !== 0) {
      s.stop("Failed to start", 1);
      fail(res.stderr.trim() || "docker run failed");
    }
    s.stop("Container started");
  }

  const hs = ui.spinner();
  hs.start(`Waiting for ${baseUrl}/health…`);
  const healthy = await waitForHealth(baseUrl);
  if (!healthy) {
    hs.stop("Server didn't come up", 1);
    line(pc.dim(`Check logs with \`atelier local logs\``));
    fail("timed out waiting for /health");
  }
  hs.stop("Server healthy");

  // The console is a separate nginx container (SPA + reverse proxy) — unless
  // --no-console, boot it so `local up` gives you the web UI, not just the API.
  const consoleUrl =
    opts.console === false
      ? null
      : await startConsole(opts, port, consoleImage);

  // Local mode bypasses auth: any non-`atl_` token maps to the single local
  // user — so a placeholder key is all the local context needs.
  upsertContext(CONTEXT, { baseUrl, apiKey: opts.key });
  if (ctx.json) {
    return printJson({
      container: CONTAINER,
      console: consoleUrl ? CONSOLE_CONTAINER : null,
      baseUrl,
      consoleUrl,
      context: CONTEXT,
      gitAuth: gitAuthMode,
      githubToken: Boolean(gitToken),
    });
  }
  line(pc.green(`✓ local server ready at ${pc.cyan(baseUrl)}`));
  if (consoleUrl) {
    line(pc.green(`✓ console ready at ${pc.cyan(consoleUrl)}`));
  }
  line(pc.dim(`  context "${CONTEXT}" is now active`));
  // Only meaningful when we actually created the container; a restart reuses
  // the existing env (token already baked in or not), so don't mislead.
  if (state === "absent") {
    line(
      pc.dim(
        gitToken
          ? `  git auth: ${gitAuthMode} (private repos enabled)`
          : `  git auth: ${gitAuthMode} (public repos only)`,
      ),
    );
  }
  line(
    pc.dim(
      consoleUrl
        ? `  open ${consoleUrl} in your browser, or run \`atelier\` for the cockpit`
        : "  run `atelier` to open the cockpit, or `atelier local down` to stop",
    ),
  );
}

async function down(ctx: Ctx, opts: { volume: boolean }): Promise<void> {
  await ensureDocker();
  const s = ui.spinner();
  s.start("Stopping local server…");
  // Remove both the server and the console container (either may be absent).
  const rm = await docker(["rm", "-f", CONTAINER, CONSOLE_CONTAINER]);
  if (rm.code !== 0 && !/no such container/i.test(rm.stderr)) {
    s.stop("Failed", 1);
    fail(rm.stderr.trim() || "docker rm failed");
  }
  if (opts.volume) await docker(["volume", "rm", "-f", VOLUME]);
  s.stop("Stopped");
  if (ctx.json) {
    return printJson({
      removed: [CONTAINER, CONSOLE_CONTAINER],
      volume: opts.volume,
    });
  }
  line(
    `removed ${CONTAINER} + ${CONSOLE_CONTAINER}${opts.volume ? ` + volume ${VOLUME}` : ""}`,
  );
  line(
    pc.dim(
      `context "${CONTEXT}" left intact — switch with \`atelier context use\``,
    ),
  );
}

async function status(ctx: Ctx): Promise<void> {
  await ensureDocker();
  const state = await runState(CONTAINER);
  const consoleState = await runState(CONSOLE_CONTAINER);
  const cfg = loadConfig();
  const localUrl =
    cfg.contexts.includes(CONTEXT) && cfg.context === CONTEXT
      ? cfg.baseUrl
      : "http://127.0.0.1:4000";
  const healthy =
    state === "running" ? await waitForHealth(localUrl, 3_000) : false;
  if (ctx.json) {
    return printJson({
      container: CONTAINER,
      state,
      healthy,
      consoleContainer: CONSOLE_CONTAINER,
      consoleState,
      baseUrl: localUrl,
      contextActive: cfg.context === CONTEXT,
    });
  }
  const stateColor = (st: string) =>
    st === "running" ? pc.green(st) : pc.dim(st);
  line(pc.bold("atelier local"));
  line(`  server      ${stateColor(state)}`);
  line(`  console     ${stateColor(consoleState)}`);
  line(
    `  ${ok(healthy)} healthy    ${pc.dim(healthy ? localUrl : "not responding")}`,
  );
  line(
    `  ${ok(cfg.context === CONTEXT)} context    ${pc.dim(`active: ${cfg.context}`)}`,
  );
}

export function registerLocal(program: Command, ctx: Ctx): void {
  const local = program
    .command("local")
    .description("Run a self-hosted server locally via Docker")
    .action(() => status(ctx));

  local
    .command("up")
    .description(
      "Boot the local server container and point a `local` context at it",
    )
    .option(
      "--nightly",
      "use the bleeding-edge `nightly` images instead of `latest`",
      false,
    )
    .option("--image <ref>", "server image (overrides --nightly)")
    .option("--console-image <ref>", "console image (overrides --nightly)")
    .option(
      "--sandbox-image <ref>",
      "default base image for new sandboxes (overrides --nightly)",
    )
    .option("--port <n>", "host port for the API", "4000")
    .option(
      "--console-port <n>",
      "host port for the console UI",
      DEFAULT_CONSOLE_PORT,
    )
    .option("--no-console", "don't start the console UI container")
    .option(
      "--git-auth <mode>",
      "how to inject a GitHub token for private repos in sandboxes: " +
        "gh|env|pat|none|ask (default: ask once, then remembered)",
    )
    .option("--network <mode>", "docker network mode (host|bridge)", "host")
    .option("--key <token>", "API key for the local context", "local")
    .action((opts: UpOpts) => up(ctx, opts));

  local
    .command("down")
    .description("Stop and remove the local server + console containers")
    .option(
      "--volume",
      "also delete the data volume (wipes local state)",
      false,
    )
    .action((opts: { volume: boolean }) => down(ctx, opts));

  local
    .command("status")
    .description("Show the local server's container + health")
    .action(() => status(ctx));

  local
    .command("logs")
    .description("Follow the local server's logs")
    .option("--console", "follow the console container's logs instead", false)
    .action(async (opts: { console: boolean }) => {
      await ensureDocker();
      const target = opts.console ? CONSOLE_CONTAINER : CONTAINER;
      process.exit(await runInherit(["docker", "logs", "-f", target]));
    });
}

export const LOCAL_CONTEXT = CONTEXT;

/** Shared by onboarding: boot local + wire the context (interactive spinner). */
export async function bootstrapLocal(ctx: Ctx): Promise<void> {
  await up(ctx, {
    port: "4000",
    network: "host",
    key: "local",
  });
}
