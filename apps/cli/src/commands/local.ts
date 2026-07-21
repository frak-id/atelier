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
import { spawn } from "node:child_process";
import type { Command } from "commander";
import pc from "picocolors";
import { createClient } from "../client.ts";
import { loadConfig, upsertContext } from "../config.ts";
import type { Ctx } from "../context.ts";
import { fail, line, printJson } from "../output.ts";
import { runInherit } from "../proc.ts";
import * as ui from "../ui.ts";

const CONTAINER = "atelier-local-server";
const VOLUME = "atelier-local-data";
const CONTEXT = "local";
/** The two images `local up` runs. The tag is picked by the release channel
 * (`latest` by default, or `nightly` for the bleeding-edge CI build). */
const SERVER_IMAGE_REPO = "ghcr.io/frak-id/atelier-server";
/** Prebuilt public base image new sandboxes boot from (agent baked in). */
const SANDBOX_IMAGE_REPO = "ghcr.io/frak-id/atelier-dev-base";
const DEFAULT_CHANNEL = "latest";
const DOCKER_SOCK = "/var/run/docker.sock";

/** Resolve the server + sandbox image refs for a run. An explicit --image /
 * --sandbox-image always wins; otherwise --nightly flips both to the `nightly`
 * tag together (so the server and its default base image stay in lockstep). */
function resolveImages(opts: {
  image?: string;
  sandboxImage?: string;
  nightly?: boolean;
}): { image: string; sandboxImage: string } {
  const channel = opts.nightly ? "nightly" : DEFAULT_CHANNEL;
  return {
    image: opts.image ?? `${SERVER_IMAGE_REPO}:${channel}`,
    sandboxImage: opts.sandboxImage ?? `${SANDBOX_IMAGE_REPO}:${channel}`,
  };
}

/** Run `docker <args>`, capturing stdout/stderr + exit code (never rejects). */
function docker(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: `${e}` }));
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
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

/** Container run-state: "running", "stopped", or "absent". */
async function containerState(): Promise<"running" | "stopped" | "absent"> {
  const res = await docker(["inspect", "-f", "{{.State.Running}}", CONTAINER]);
  if (res.code !== 0) return "absent";
  return res.stdout.trim() === "true" ? "running" : "stopped";
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
  sandboxImage?: string;
  nightly?: boolean;
  port: string;
  network: string;
  key: string;
}

async function up(ctx: Ctx, opts: UpOpts): Promise<void> {
  await ensureDocker();
  const port = Number(opts.port);
  if (!Number.isFinite(port)) fail("--port must be a number");
  const baseUrl = `http://127.0.0.1:${port}`;
  const { image, sandboxImage } = resolveImages(opts);

  const s = ui.spinner();
  s.start("Starting local server…");
  const state = await containerState();
  if (state === "running") {
    s.stop("Already running");
  } else if (state === "stopped") {
    const res = await docker(["start", CONTAINER]);
    if (res.code !== 0) {
      s.stop("Failed to start", 1);
      fail(res.stderr.trim() || "docker start failed");
    }
    s.stop("Restarted existing container");
  } else {
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
    // Bridge networking can't bind the host port implicitly — publish it.
    if (opts.network !== "host") runArgs.push("-p", `${port}:${port}`);
    runArgs.push(image);
    const res = await docker(runArgs);
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

  // Local mode bypasses auth: any non-`atl_` token maps to the single local
  // user — so a placeholder key is all the local context needs.
  upsertContext(CONTEXT, { baseUrl, apiKey: opts.key });
  if (ctx.json) {
    return printJson({ container: CONTAINER, baseUrl, context: CONTEXT });
  }
  line(pc.green(`✓ local server ready at ${pc.cyan(baseUrl)}`));
  line(pc.dim(`  context "${CONTEXT}" is now active`));
  line(
    pc.dim(
      "  run `atelier` to open the cockpit, or `atelier local down` to stop",
    ),
  );
}

async function down(ctx: Ctx, opts: { volume: boolean }): Promise<void> {
  await ensureDocker();
  const s = ui.spinner();
  s.start("Stopping local server…");
  const rm = await docker(["rm", "-f", CONTAINER]);
  if (rm.code !== 0 && !/no such container/i.test(rm.stderr)) {
    s.stop("Failed", 1);
    fail(rm.stderr.trim() || "docker rm failed");
  }
  if (opts.volume) await docker(["volume", "rm", "-f", VOLUME]);
  s.stop("Stopped");
  if (ctx.json) return printJson({ removed: CONTAINER, volume: opts.volume });
  line(`removed ${CONTAINER}${opts.volume ? ` + volume ${VOLUME}` : ""}`);
  line(
    pc.dim(
      `context "${CONTEXT}" left intact — switch with \`atelier context use\``,
    ),
  );
}

async function status(ctx: Ctx): Promise<void> {
  await ensureDocker();
  const state = await containerState();
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
      baseUrl: localUrl,
      contextActive: cfg.context === CONTEXT,
    });
  }
  const ok = (b: boolean) => (b ? pc.green("✓") : pc.red("✗"));
  line(pc.bold("atelier local"));
  line(
    `  container   ${state === "running" ? pc.green(state) : pc.dim(state)}`,
  );
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
    .option(
      "--sandbox-image <ref>",
      "default base image for new sandboxes (overrides --nightly)",
    )
    .option("--port <n>", "host port for the API", "4000")
    .option("--network <mode>", "docker network mode (host|bridge)", "host")
    .option("--key <token>", "API key for the local context", "local")
    .action((opts: UpOpts) => up(ctx, opts));

  local
    .command("down")
    .description("Stop and remove the local server container")
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
    .action(async () => {
      await ensureDocker();
      process.exit(await runInherit(["docker", "logs", "-f", CONTAINER]));
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
