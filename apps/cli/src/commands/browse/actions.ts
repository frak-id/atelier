/** The per-sandbox action menu: shell, open URL, attach, exec, tail logs,
 * start/stop/restart processes, capture, pause/resume, remove. */
import type { SandboxState } from "@atelier/spec";
import pc from "picocolors";
import { attach } from "../../attach.ts";
import { type AtelierApi, unwrap } from "../../client.ts";
import type { CliConfig } from "../../config.ts";
import { line, statusColor } from "../../output.ts";
import { runInherit } from "../../proc.ts";
import { resolveSshRegistration } from "../../ssh-keys.ts";
import * as ui from "../../ui.ts";
import { openInBrowser, parseEnvPairs } from "../../util.ts";
import { followLogs } from "../logs-follow.ts";
import { sshCommand } from "../sandbox-helpers.ts";
import { captureFlow } from "./capture.ts";
import { BACK } from "./common.ts";

/** Non-ssh URLs that are actually reachable: `ready === false` means a gating
 * process isn't up yet, so opening it would just fail — exclude those. An
 * undefined `ready` (ungated) counts as available. */
function openableUrls(state: SandboxState): SandboxState["urls"] {
  return state.urls.filter((u) => u.name !== "ssh" && u.ready !== false);
}

export function summarize(state: SandboxState, sshReady: boolean): void {
  const lines: string[] = [`status: ${statusColor(state.status)}`];
  if (state.processes.length > 0) {
    lines.push(
      `processes: ${state.processes
        .map((p) => `${p.name}${p.running ? pc.green("↑") : pc.dim("↓")}`)
        .join("  ")}`,
    );
  }
  for (const u of state.urls) {
    // Hide the ssh endpoint entirely when SSH isn't set up locally.
    if (u.name === "ssh" && !sshReady) continue;
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
  | "start"
  | "stop"
  | "restart"
  | "capture"
  | "pause"
  | "resume"
  | "refresh"
  | "rm"
  | "back";

/** SSH is "set up" when a local key exists AND it's registered on the server
 * — the same readiness `config doctor` reports. Computed once per cockpit
 * session; when false the SSH shell option is hidden entirely. */
export async function computeSshReady(api: AtelierApi): Promise<boolean> {
  try {
    return Boolean((await resolveSshRegistration(api)).registered);
  } catch {
    return false;
  }
}

function actionMenu(
  state: SandboxState,
  sshReady: boolean,
): {
  value: Action;
  label: string;
  hint?: string;
}[] {
  const running = state.status === "running";
  const paused = state.status === "paused";
  const opts: { value: Action; label: string; hint?: string }[] = [];
  if (running) {
    // Only offer SSH when it will actually work (key set up + registered).
    if (sshReady && sshCommand(state.urls)) {
      opts.push({ value: "shell", label: "Open SSH shell" });
    }
    // Only offer "Open URL" when at least one non-ssh URL is actually reachable.
    if (openableUrls(state).length > 0) {
      opts.push({ value: "open", label: "Open URL in browser" });
    }
    opts.push(
      { value: "attach", label: "Attach to a process (Ctrl-] detaches)" },
      { value: "exec", label: "Run a command" },
      { value: "tail", label: "Follow logs (live)" },
      { value: "start", label: "Start a process" },
      { value: "stop", label: "Stop a process" },
      { value: "restart", label: "Restart a process" },
      { value: "capture", label: "Capture (toolset / toolbox)" },
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
export async function runAction(
  api: AtelierApi,
  cfg: CliConfig,
  id: string,
  state: SandboxState,
  sshReady: boolean,
): Promise<boolean> {
  const action = await ui.select<Action>({
    message: id,
    options: actionMenu(state, sshReady),
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
        ui.note("No ssh endpoint.");
        return true;
      }
      line(pc.dim(`$ ${cmd.join(" ")}`));
      await runInherit(cmd);
      return true;
    }
    case "open": {
      const openable = openableUrls(state);
      // Single reachable URL opens directly; several prompt a picker.
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
    case "tail": {
      const name = await pickProcess(state, "Which process?");
      if (name === BACK) return true;
      await tailLogs(api, id, name);
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
    case "capture": {
      await captureFlow(api, id);
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
