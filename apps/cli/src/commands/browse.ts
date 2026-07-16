/** `atelier browse` (alias `i`) — the interactive sandbox cockpit: pick a
 * sandbox, then drive it (shell, attach, start/stop processes, logs, exec,
 * pause/resume, snapshot, remove). */
import type { SandboxState } from "@atelier/spec";
import type { Command } from "commander";
import pc from "picocolors";
import { attach } from "../attach.ts";
import { type AtelierApi, unwrap } from "../client.ts";
import type { CliConfig } from "../config.ts";
import type { Ctx } from "../context.ts";
import { line, statusColor } from "../output.ts";
import * as ui from "../ui.ts";
import { describeAnnotations, sshCommand } from "./sandbox-helpers.ts";

const BACK = Symbol("back");

/** Pick a sandbox from the live list. Returns its id, or `null` to quit. */
async function pickSandbox(api: AtelierApi): Promise<string | null> {
  const s = ui.spinner();
  s.start("Loading sandboxes…");
  const rows = unwrap(await api.v1.sandboxes.get());
  s.stop(`${rows.length} sandbox(es)`);
  if (rows.length === 0) {
    ui.note("Run `atelier up` to create one.", "No sandboxes");
    return null;
  }
  const choice = await ui.select<string>({
    message: "Pick a sandbox",
    options: [
      ...rows.map((r) => ({
        value: r.id,
        label: `${r.id}  ${statusColor(r.status)}`,
        hint: describeAnnotations(r.annotations),
      })),
      { value: "__quit__", label: pc.dim("Quit") },
    ],
  });
  return choice === "__quit__" ? null : choice;
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
  for (const u of state.urls) lines.push(`${u.name}: ${pc.cyan(u.url)}`);
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

/** Run one action against the picked sandbox. Returns false to leave the
 * action menu (back to sandbox picker). */
async function runAction(
  api: AtelierApi,
  cfg: CliConfig,
  id: string,
  state: SandboxState,
): Promise<boolean> {
  type Action =
    | "shell"
    | "attach"
    | "start"
    | "stop"
    | "logs"
    | "exec"
    | "pause"
    | "resume"
    | "snapshot"
    | "rm"
    | "refresh"
    | "back";

  const running = state.status === "running";
  const paused = state.status === "paused";
  const options: { value: Action; label: string; hint?: string }[] = [];
  if (running) {
    if (sshCommand(state.urls)) {
      options.push({ value: "shell", label: "Open SSH shell" });
    }
    options.push(
      { value: "attach", label: "Attach to a process (Ctrl-] detaches)" },
      { value: "start", label: "Start a process" },
      { value: "stop", label: "Stop a process" },
      { value: "logs", label: "View process logs" },
      { value: "exec", label: "Run a command" },
      { value: "snapshot", label: "Snapshot" },
      { value: "pause", label: "Pause" },
    );
  }
  if (paused) options.push({ value: "resume", label: "Resume" });
  options.push(
    { value: "refresh", label: pc.dim("Refresh") },
    { value: "rm", label: pc.red("Remove") },
    { value: "back", label: pc.dim("Back to list") },
  );

  const action = await ui.select<Action>({ message: `${id}`, options });

  switch (action) {
    case "back":
      return false;
    case "refresh":
      return true;
    case "shell": {
      const cmd = sshCommand(state.urls);
      if (!cmd) {
        ui.note("No ssh endpoint.");
        return true;
      }
      line(pc.dim(`$ ${cmd.join(" ")}`));
      const proc = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] });
      await proc.exited;
      return true;
    }
    case "attach": {
      const name = await pickProcess(state, "Attach to which process?");
      if (name === BACK) return true;
      line(pc.dim("attaching — press Ctrl-] to detach"));
      await attach(cfg, id, name);
      return true;
    }
    case "start": {
      const name = await pickProcess(state, "Start which process?", (r) => !r);
      if (name === BACK) return true;
      const s = ui.spinner();
      s.start(`Starting ${name}…`);
      await api.v1
        .sandboxes({ id })
        .processes({ name })({ action: "start" })
        .post()
        .then(unwrap);
      s.stop(`Started ${name}`);
      return true;
    }
    case "stop": {
      const name = await pickProcess(state, "Stop which process?", (r) => r);
      if (name === BACK) return true;
      const s = ui.spinner();
      s.start(`Stopping ${name}…`);
      await api.v1
        .sandboxes({ id })
        .processes({ name })({ action: "stop" })
        .post()
        .then(unwrap);
      s.stop(`Stopped ${name}`);
      return true;
    }
    case "logs": {
      const name = await pickProcess(state, "Logs for which process?");
      if (name === BACK) return true;
      const { content } = unwrap(
        await api.v1.sandboxes({ id }).processes({ name }).logs.get(),
      );
      line(content.trimEnd() || pc.dim("(no output)"));
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
    case "pause": {
      const s = ui.spinner();
      s.start("Pausing…");
      await api.v1.sandboxes({ id }).pause.post().then(unwrap);
      s.stop("Paused");
      return true;
    }
    case "resume": {
      const s = ui.spinner();
      s.start("Resuming…");
      await api.v1.sandboxes({ id }).resume.post({}).then(unwrap);
      s.stop("Resumed");
      return true;
    }
    case "snapshot": {
      const s = ui.spinner();
      s.start("Snapshotting…");
      const ref = unwrap(await api.v1.sandboxes({ id }).snapshot.post());
      s.stop(`Snapshot ${ref.ref}`);
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
  // Outer loop: pick a sandbox, drive it, come back to the list.
  while (true) {
    const id = await pickSandbox(api);
    if (!id) break;
    // Inner loop: run actions until the user goes back or removes it.
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
