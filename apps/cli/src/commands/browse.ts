/** `atelier browse` (alias `i`) — the interactive sandbox cockpit: pick a
 * sandbox (or spawn a new one), then drive it (shell, browser, attach,
 * processes, logs/tail, exec, expose, env, sync, snapshot, pause/resume,
 * remove). */
import type { SandboxState } from "@atelier/spec";
import type { Command } from "commander";
import pc from "picocolors";
import { attach } from "../attach.ts";
import { type AtelierApi, unwrap } from "../client.ts";
import type { CliConfig } from "../config.ts";
import type { Ctx } from "../context.ts";
import { age, line, statusColor } from "../output.ts";
import { atelierKeyExists } from "../ssh-keys.ts";
import * as ui from "../ui.ts";
import { collectFiles, openInBrowser, parseEnvPairs } from "../util.ts";
import { followLogs } from "./logs-follow.ts";
import { describeAnnotations, sshCommand } from "./sandbox-helpers.ts";

const BACK = Symbol("back");
const NEW = "__new__";
const QUIT = "__quit__";
const FILTER = "__filter__";

/** Pick a sandbox from the live list, with an optional name filter and entries
 * to spawn a new one or quit. Returns an id, `NEW`, or null (quit). */
async function pickSandbox(
  api: AtelierApi,
  filter?: string,
): Promise<string | typeof NEW | null> {
  const s = ui.spinner();
  s.start("Loading sandboxes…");
  let rows = unwrap(await api.v1.sandboxes.get());
  s.stop(`${rows.length} sandbox(es)`);
  if (filter) {
    const f = filter.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.id.toLowerCase().includes(f) ||
        describeAnnotations(r.annotations).toLowerCase().includes(f),
    );
  }
  const choice = await ui.select<string>({
    message: filter ? `Sandboxes matching "${filter}"` : "Pick a sandbox",
    options: [
      { value: NEW, label: pc.green("+ New sandbox") },
      ...(rows.length > 8 || filter
        ? [{ value: FILTER, label: pc.dim("Filter…") }]
        : []),
      ...rows.map((r) => ({
        value: r.id,
        label: `${r.id}  ${statusColor(r.status)}`,
        hint: `${describeAnnotations(r.annotations)} · ${age(r.createdAt)}`,
      })),
      { value: QUIT, label: pc.dim("Quit") },
    ],
  });
  if (choice === QUIT) return null;
  if (choice === NEW) return NEW;
  if (choice === FILTER) {
    const term = await ui.text({ message: "Filter", placeholder: "repo / id" });
    return pickSandbox(api, term.trim() || undefined);
  }
  return choice;
}

function summarize(state: SandboxState): void {
  const lines: string[] = [`status: ${statusColor(state.status)}`];
  if (state.processes.length > 0) {
    lines.push(
      `processes: ${state.processes
        .map((p) => `${p.name}${p.running ? pc.green("↑") : pc.dim("↓")}`)
        .join("  ")}`,
    );
  }
  for (const u of state.urls) {
    const ready = u.ready === false ? pc.yellow(" (not ready)") : "";
    lines.push(`${u.name}: ${pc.cyan(u.url)}${ready}`);
  }
  ui.note(lines.join("\n"), state.id);
}

async function pickProcess(
  state: SandboxState,
  message: string,
  filter?: (running: boolean) => boolean,
): Promise<string | typeof BACK> {
  const procs = state.processes.filter((p) =>
    filter ? filter(p.running) : true,
  );
  if (procs.length === 0) {
    ui.note("No matching processes.");
    return BACK;
  }
  return ui.select<string | typeof BACK>({
    message,
    options: [
      ...procs.map((p) => ({
        value: p.name as string,
        label: `${p.name} ${p.running ? statusColor("running") : pc.dim("stopped")}`,
      })),
      { value: BACK, label: pc.dim("Back") },
    ],
  });
}

/** Spawn a new sandbox from within the cockpit: image ref, saved spec, or
 * prebuild snapshot. Returns the new id, or null if cancelled. */
async function spawnFlow(api: AtelierApi): Promise<string | null> {
  const source = await ui.select<"image" | "spec" | "prebuild" | "cancel">({
    message: "New sandbox from…",
    options: [
      { value: "image", label: "Image ref" },
      { value: "spec", label: "Saved spec" },
      { value: "prebuild", label: "Prebuild snapshot" },
      { value: "cancel", label: pc.dim("Cancel") },
    ],
  });
  if (source === "cancel") return null;

  let body: unknown;
  if (source === "image") {
    const image = await ui.text({
      message: "Image ref",
      placeholder: "ghcr.io/org/dev:latest",
    });
    if (!image.trim()) return null;
    body = {
      source: { image: image.trim() },
      resources: { vcpus: 2, memoryMb: 2048 },
    };
  } else if (source === "spec") {
    const specs = unwrap(await api.api["saved-specs"].get());
    if (specs.length === 0) {
      ui.note("No saved specs. Create one with `atelier spec save`.");
      return null;
    }
    const id = await ui.select<string>({
      message: "Which spec?",
      options: specs.map((s) => ({ value: s.id, label: s.name })),
    });
    body = specs.find((s) => s.id === id)?.spec;
  } else {
    const prebuilds = unwrap(await api.v1.prebuilds.get());
    if (prebuilds.length === 0) {
      ui.note("No prebuilds. Bake one with `atelier prebuild run`.");
      return null;
    }
    const ref = await ui.select<string>({
      message: "Which prebuild?",
      options: prebuilds.map((p) => ({
        value: p.ref,
        label: p.ref,
        hint: p.hash,
      })),
    });
    body = {
      source: { snapshot: ref },
      resources: { vcpus: 2, memoryMb: 2048 },
    };
  }

  const s = ui.spinner();
  s.start("Creating…");
  const result = unwrap(
    // biome-ignore lint/suspicious/noExplicitAny: body is a validated spec union
    await api.v1.sandboxes.post(body as any),
  );
  s.stop(`Created ${result.id}`);
  return result.id;
}

/** A live log tail that stops on `q` / Ctrl-C without exiting the cockpit. */
async function tailLogs(
  api: AtelierApi,
  id: string,
  name: string,
): Promise<void> {
  line(pc.dim(`following ${name} — press q or Ctrl-C to stop`));
  const controller = new AbortController();
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  const onKey = (buf: Buffer) => {
    const b = buf[0];
    if (b === 0x71 || b === 0x03 || b === 0x1d) controller.abort();
  };
  stdin.on("data", onKey);
  try {
    await followLogs(api, id, name, {
      signal: controller.signal,
      onChunk: (chunk) => process.stdout.write(chunk),
    });
  } finally {
    stdin.off("data", onKey);
    if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
    stdin.pause();
  }
}

type Action =
  | "shell"
  | "open"
  | "attach"
  | "exec"
  | "tail"
  | "logs"
  | "start"
  | "stop"
  | "restart"
  | "addproc"
  | "expose"
  | "env"
  | "sync"
  | "snapshot"
  | "pause"
  | "resume"
  | "refresh"
  | "rm"
  | "back";

function actionMenu(state: SandboxState): {
  value: Action;
  label: string;
  hint?: string;
}[] {
  const running = state.status === "running";
  const paused = state.status === "paused";
  const opts: { value: Action; label: string; hint?: string }[] = [];
  const openable = state.urls.filter((u) => u.name !== "ssh");
  if (running) {
    if (sshCommand(state.urls)) {
      opts.push({ value: "shell", label: "Open SSH shell" });
    }
    if (openable.length > 0) {
      opts.push({ value: "open", label: "Open URL in browser" });
    }
    opts.push(
      { value: "attach", label: "Attach to a process (Ctrl-] detaches)" },
      { value: "exec", label: "Run a command" },
      { value: "tail", label: "Follow logs (live)" },
      { value: "logs", label: "View logs (snapshot)" },
      { value: "start", label: "Start a process" },
      { value: "stop", label: "Stop a process" },
      { value: "restart", label: "Restart a process" },
      { value: "addproc", label: "Add a process" },
      { value: "expose", label: "Expose a port" },
      { value: "env", label: "Patch env vars" },
      { value: "sync", label: "Sync files" },
      { value: "snapshot", label: "Snapshot" },
      { value: "pause", label: "Pause" },
    );
  }
  if (paused) opts.push({ value: "resume", label: "Resume" });
  opts.push(
    { value: "refresh", label: pc.dim("Refresh") },
    { value: "back", label: pc.dim("Back to list") },
    { value: "rm", label: pc.red("── Remove (danger) ──") },
  );
  return opts;
}

/** Run one action. Returns false to leave the action menu (back to picker). */
async function runAction(
  api: AtelierApi,
  cfg: CliConfig,
  id: string,
  state: SandboxState,
): Promise<boolean> {
  const action = await ui.select<Action>({
    message: id,
    options: actionMenu(state),
  });
  const proc = (name: string, act: "start" | "stop") =>
    api.v1.sandboxes({ id }).processes({ name })({ action: act }).post();

  switch (action) {
    case "back":
      return false;
    case "refresh":
      return true;
    case "shell": {
      const cmd = sshCommand(state.urls);
      if (!cmd) {
        ui.note(
          atelierKeyExists()
            ? "No ssh endpoint."
            : "No ssh endpoint. Run `atelier ssh-key setup` first.",
        );
        return true;
      }
      line(pc.dim(`$ ${cmd.join(" ")}`));
      await Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] }).exited;
      return true;
    }
    case "open": {
      const openable = state.urls.filter((u) => u.name !== "ssh");
      const url =
        openable.length === 1
          ? openable[0]?.url
          : await ui.select<string>({
              message: "Open which URL?",
              options: openable.map((u) => ({
                value: u.url,
                label: u.name,
                hint: u.url,
              })),
            });
      if (url) {
        openInBrowser(url);
        line(`${pc.dim("opening")} ${pc.cyan(url)}`);
      }
      return true;
    }
    case "attach": {
      const name = await pickProcess(state, "Attach to which process?");
      if (name === BACK) return true;
      line(pc.dim("attaching — press Ctrl-] to detach"));
      await attach(cfg, id, name);
      return true;
    }
    case "exec": {
      const command = await ui.text({
        message: "Command",
        placeholder: "ls -la",
      });
      if (!command.trim()) return true;
      const s = ui.spinner();
      s.start("Running…");
      const res = unwrap(await api.v1.sandboxes({ id }).exec.post({ command }));
      s.stop(`exit ${res.exitCode}`);
      if (res.stdout) line(res.stdout.trimEnd());
      if (res.stderr) line(pc.red(res.stderr.trimEnd()));
      return true;
    }
    case "tail":
    case "logs": {
      const name = await pickProcess(state, "Which process?");
      if (name === BACK) return true;
      if (action === "tail") {
        await tailLogs(api, id, name);
      } else {
        const { content } = unwrap(
          await api.v1.sandboxes({ id }).processes({ name }).logs.get(),
        );
        line(content.trimEnd() || pc.dim("(no output)"));
      }
      return true;
    }
    case "start":
    case "stop": {
      const name = await pickProcess(
        state,
        `${action === "start" ? "Start" : "Stop"} which process?`,
        (r) => (action === "start" ? !r : r),
      );
      if (name === BACK) return true;
      const s = ui.spinner();
      s.start(`${action === "start" ? "Starting" : "Stopping"} ${name}…`);
      await proc(name, action).then(unwrap);
      s.stop(`${action === "start" ? "Started" : "Stopped"} ${name}`);
      return true;
    }
    case "restart": {
      const name = await pickProcess(state, "Restart which process?");
      if (name === BACK) return true;
      const s = ui.spinner();
      s.start(`Restarting ${name}…`);
      await proc(name, "stop").then(unwrap);
      await proc(name, "start").then(unwrap);
      s.stop(`Restarted ${name}`);
      return true;
    }
    case "addproc": {
      const name = await ui.text({ message: "Process name" });
      if (!name.trim()) return true;
      const command = await ui.text({ message: "Command" });
      if (!command.trim()) return true;
      const s = ui.spinner();
      s.start("Adding…");
      await api.v1
        .sandboxes({ id })
        .processes.post({ name: name.trim(), command: command.trim() })
        .then(unwrap);
      s.stop(`Added ${name.trim()}`);
      return true;
    }
    case "expose": {
      const name = await ui.text({ message: "Port name", placeholder: "web" });
      if (!name.trim()) return true;
      const portStr = await ui.text({ message: "Port", placeholder: "3000" });
      const port = Number(portStr);
      if (!Number.isFinite(port)) {
        ui.note("Invalid port.");
        return true;
      }
      const s = ui.spinner();
      s.start("Exposing…");
      await api.v1
        .sandboxes({ id })
        .ports.post({ name: name.trim(), port, public: true })
        .then(unwrap);
      s.stop(`Exposed ${name.trim()} (:${port})`);
      return true;
    }
    case "env": {
      const raw = await ui.text({
        message: "Env vars (space-separated KEY=VALUE)",
        placeholder: "FOO=bar BAZ=qux",
      });
      if (!raw.trim()) return true;
      const env = parseEnvPairs(raw.trim().split(/\s+/));
      const s = ui.spinner();
      s.start("Patching…");
      await api.v1.sandboxes({ id }).env.patch(env).then(unwrap);
      s.stop(`Patched ${Object.keys(env).length} var(s)`);
      return true;
    }
    case "sync": {
      const local = await ui.text({
        message: "Local path",
        placeholder: "./.config",
      });
      if (!local.trim()) return true;
      const remote = await ui.text({
        message: "Remote path",
        placeholder: "/home/dev/.config",
      });
      if (!remote.trim()) return true;
      const files = collectFiles(local.trim(), remote.trim());
      if (files.length === 0) {
        ui.note("No files found.");
        return true;
      }
      const s = ui.spinner();
      s.start(`Syncing ${files.length} file(s)…`);
      await api.v1.sandboxes({ id }).files.patch(files).then(unwrap);
      s.stop(`Synced ${files.length} file(s)`);
      return true;
    }
    case "snapshot": {
      const s = ui.spinner();
      s.start("Snapshotting…");
      const ref = unwrap(await api.v1.sandboxes({ id }).snapshot.post());
      s.stop(`Snapshot ${ref.ref}`);
      return true;
    }
    case "pause": {
      const s = ui.spinner();
      s.start("Pausing…");
      await api.v1.sandboxes({ id }).pause.post().then(unwrap);
      s.stop("Paused");
      return true;
    }
    case "resume": {
      const raw = await ui.text({
        message: "Env to inject on resume (optional, KEY=VALUE …)",
        placeholder: "",
        defaultValue: "",
      });
      const env = raw.trim() ? parseEnvPairs(raw.trim().split(/\s+/)) : {};
      const s = ui.spinner();
      s.start("Resuming…");
      await api.v1
        .sandboxes({ id })
        .resume.post(Object.keys(env).length > 0 ? { env } : {})
        .then(unwrap);
      s.stop("Resumed");
      return true;
    }
    case "rm": {
      const yes = await ui.confirm({
        message: `Remove ${id}? This is irreversible.`,
        initialValue: false,
      });
      if (!yes) return true;
      const s = ui.spinner();
      s.start("Removing…");
      await api.v1.sandboxes({ id }).delete().then(unwrap);
      s.stop(`Removed ${id}`);
      return false;
    }
  }
}

/** The interactive cockpit loop — reused by `atelier browse` and by bare
 * `atelier` (no args). */
export async function browseInteractive(ctx: Ctx): Promise<void> {
  if (!ui.isInteractive()) {
    line(pc.red("browse needs an interactive terminal"));
    process.exit(1);
  }
  const api = ctx.api();
  const cfg = ctx.config();
  ui.intro(pc.cyan("atelier"));
  while (true) {
    const picked = await pickSandbox(api);
    if (!picked) break;
    const id = picked === NEW ? await spawnFlow(api) : picked;
    if (!id) continue;
    // Inner loop: drive one sandbox until back / removed.
    let inMenu = true;
    while (inMenu) {
      let state: SandboxState;
      try {
        state = unwrap(await api.v1.sandboxes({ id }).get());
      } catch {
        ui.note("Sandbox is gone.");
        break;
      }
      summarize(state);
      inMenu = await runAction(api, cfg, id, state);
    }
  }
  ui.outro("Bye.");
}

export function registerBrowse(program: Command, ctx: Ctx): void {
  program
    .command("browse")
    .aliases(["i", "interactive"])
    .description("Interactively browse and drive sandboxes")
    .action(() => browseInteractive(ctx));
}
