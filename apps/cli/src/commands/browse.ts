/** `atelier browse` (alias `i`) — the interactive sandbox cockpit: pick a
 * sandbox (or spawn a new one), then drive it (shell, browser, attach,
 * processes, logs, exec, pause/resume, remove). An Account entry exposes
 * identity + SSH readiness and one-shot SSH setup/regenerate. Advanced,
 * rarely-used actions (expose/env/sync/snapshot/add-process) live as scriptable
 * subcommands to keep this menu lean. */
import type {
  CreateSandboxResponse,
  PrebuildRecord,
  SandboxState,
  ToolboxConfig,
} from "@atelier/spec";
import type { Command } from "commander";
import pc from "picocolors";
import { attach } from "../attach.ts";
import {
  ApiError,
  type AtelierApi,
  type JobRecord,
  unwrap,
  waitForJob,
} from "../client.ts";
import type { CliConfig } from "../config.ts";
import type { Ctx } from "../context.ts";
import { age, line, statusColor } from "../output.ts";
import { runInherit } from "../proc.ts";
import {
  ATELIER_KEY_PATH,
  defaultKeyLabel,
  generateAtelierKey,
  type LocalKey,
  listLocalKeys,
  readLocalKey,
  removeAtelierKey,
} from "../ssh-keys.ts";
import * as ui from "../ui.ts";
import { openInBrowser, parseEnvPairs } from "../util.ts";
import { followLogs } from "./logs-follow.ts";
import { describeAnnotations, sshCommand } from "./sandbox-helpers.ts";

const BACK = Symbol("back");
const NEW = "__new__";
const QUIT = "__quit__";
const FILTER = "__filter__";
const ACCOUNT = "__account__";

const ok = (v: boolean): string => (v ? pc.green("✓") : pc.red("✗"));

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
      { value: ACCOUNT, label: pc.dim("Account & SSH") },
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

/** Non-ssh URLs that are actually reachable: `ready === false` means a gating
 * process isn't up yet, so opening it would just fail — exclude those. An
 * undefined `ready` (ungated) counts as available. */
function openableUrls(state: SandboxState): SandboxState["urls"] {
  return state.urls.filter((u) => u.name !== "ssh" && u.ready !== false);
}

function summarize(state: SandboxState, sshReady: boolean): void {
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

/** The Account & SSH panel: show identity + SSH readiness, then offer to set up
 * or regenerate the atelier SSH key. Kept out of the per-sandbox menu so global
 * concerns live in one place. */
async function accountMenu(api: AtelierApi): Promise<void> {
  const s = ui.spinner();
  s.start("Loading account…");
  let me: Awaited<ReturnType<typeof loadMe>>;
  let registered: LocalKey | undefined;
  let localCount = 0;
  try {
    me = await loadMe(api);
    const remote = unwrap(await api.api["ssh-keys"].get());
    const localKeys = listLocalKeys();
    localCount = localKeys.length;
    registered = localKeys.find((k) =>
      remote.some((r) => r.fingerprint === k.fingerprint),
    );
    s.stop("Account");
  } catch (err) {
    s.stop("Failed to load account");
    ui.note(err instanceof Error ? err.message : String(err));
    return;
  }

  const info = [`${pc.bold(me.username)}  ${pc.dim(me.email)}`, `id: ${me.id}`];
  if (me.organizations.length > 0) {
    info.push(`orgs: ${me.organizations.map((o) => o.name).join(", ")}`);
  }
  info.push("");
  info.push(
    `${ok(localCount > 0)} local ssh key ${pc.dim(localCount > 0 ? `${localCount} in ~/.ssh` : "none found")}`,
  );
  info.push(
    `${ok(Boolean(registered))} ssh registered ${pc.dim(registered ? registered.fingerprint : "not set up")}`,
  );
  ui.note(info.join("\n"), "account");

  const action = await ui.select<"setup" | "regen" | "back">({
    message: "Account & SSH",
    options: [
      registered
        ? {
            value: "regen",
            label: "Regenerate SSH key",
            hint: "replace + re-register",
          }
        : {
            value: "setup",
            label: "Set up SSH",
            hint: "generate + register a key",
          },
      { value: "back", label: pc.dim("Back") },
    ],
  });
  if (action === "setup") await setupSsh(api);
  else if (action === "regen") await regenSsh(api);
}

function loadMe(api: AtelierApi) {
  return api.api.me.get().then(unwrap);
}

/** Generate the atelier key (if missing) and register it — the cockpit twin of
 * `atelier ssh-key setup`. */
async function setupSsh(api: AtelierApi): Promise<void> {
  const s = ui.spinner();
  s.start("Generating key…");
  try {
    const local = await generateAtelierKey();
    s.message("Registering…");
    const remote = unwrap(await api.api["ssh-keys"].get());
    if (!remote.some((r) => r.fingerprint === local.fingerprint)) {
      unwrap(
        await api.api["ssh-keys"].post({
          publicKey: local.publicKey,
          name: defaultKeyLabel(),
          type: "generated",
        }),
      );
    }
    s.stop("SSH set up");
    ui.note(
      `${ok(true)} ${local.fingerprint}\nprivate key: ${pc.dim(ATELIER_KEY_PATH)}`,
    );
  } catch (err) {
    s.stop("Setup failed");
    ui.note(err instanceof Error ? err.message : String(err));
  }
}

/** De-register + delete the atelier key, then generate and register a fresh
 * one. Destructive, so it confirms first. */
async function regenSsh(api: AtelierApi): Promise<void> {
  const yes = await ui.confirm({
    message:
      "Regenerate the atelier SSH key? The old key is removed everywhere.",
    initialValue: false,
  });
  if (!yes) return;
  const s = ui.spinner();
  s.start("Regenerating…");
  try {
    const current = readLocalKey(`${ATELIER_KEY_PATH}.pub`);
    if (current) {
      const remote = unwrap(await api.api["ssh-keys"].get());
      const match = remote.find((r) => r.fingerprint === current.fingerprint);
      if (match)
        await api.api["ssh-keys"]({ id: match.id }).delete().then(unwrap);
    }
    removeAtelierKey();
    s.message("Generating new key…");
    const local = await generateAtelierKey();
    s.message("Registering…");
    unwrap(
      await api.api["ssh-keys"].post({
        publicKey: local.publicKey,
        name: defaultKeyLabel(),
        type: "generated",
      }),
    );
    s.stop("SSH key regenerated");
    ui.note(
      `${ok(true)} ${local.fingerprint}\nprivate key: ${pc.dim(ATELIER_KEY_PATH)}`,
    );
  } catch (err) {
    s.stop("Regenerate failed");
    ui.note(err instanceof Error ? err.message : String(err));
  }
}

/** Trim a clone URL down to `owner/name` for a compact prebuild label. */
function shortRepo(url: string): string {
  return url
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^git@[^:]+:/, "")
    .replace(/\.git$/, "");
}

/** A one-line summary for a prebuild: repo@branch · build age · base image. */
function prebuildHint(p: PrebuildRecord): string {
  const repo =
    p.spec?.repos?.[0]?.url ?? p.metadata?.repo ?? p.metadata?.workspace;
  const branch = p.spec?.repos?.[0]?.branch ?? p.metadata?.branch;
  const parts: string[] = [];
  if (repo) parts.push(shortRepo(repo) + (branch ? `@${branch}` : ""));
  parts.push(`built ${age(p.createdAt)} ago`);
  if (p.image) parts.push(p.image);
  return parts.join(" · ");
}

const toolboxSelector = (t: ToolboxConfig) =>
  `tb/${t.ownerType}/${t.ownerId}/${t.slug}`;

/** Surface a toolbox provides, mirroring the console's spawn badges: whether
 * it's always-on, its harness, the processes it runs, and its description. */
function toolboxHint(t: ToolboxConfig): string {
  const parts: string[] = [];
  if (t.autoInject) parts.push("always on");
  if (t.harness) parts.push(`harness: ${t.harness}`);
  if (t.processes && t.processes.length > 0) {
    parts.push(`runs: ${t.processes.map((p) => p.name).join(",")}`);
  }
  if (t.description) parts.push(t.description);
  return parts.join(" · ");
}

/** Every toolbox visible to the caller (personal + each org they belong to). */
async function gatherToolboxes(api: AtelierApi): Promise<ToolboxConfig[]> {
  const me = unwrap(await api.api.me.get());
  const owners: (string | undefined)[] = [
    undefined,
    ...me.organizations.map((o) => `org:${o.id}`),
  ];
  const lists = await Promise.all(
    owners.map((o) =>
      api.api.toolboxes.get({ query: o ? { owner: o } : {} }).then(unwrap),
    ),
  );
  const seen = new Set<string>();
  return lists.flat().filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

/** Offer the caller's toolboxes as a multi-select. Auto-inject toolboxes are
 * pre-checked and always included (the server injects them regardless). */
async function pickToolboxes(api: AtelierApi): Promise<string[]> {
  const toolboxes = await gatherToolboxes(api).catch(() => []);
  if (toolboxes.length === 0) return [];
  const forced = toolboxes.filter((t) => t.autoInject).map(toolboxSelector);
  const picks = await ui.multiselect<string>({
    message: "Toolsets to layer on (auto ones are always on)",
    required: false,
    initialValues: forced,
    options: toolboxes.map((t) => ({
      value: toolboxSelector(t),
      label: t.slug,
      hint: toolboxHint(t),
    })),
  });
  return Array.from(new Set([...forced, ...picks]));
}

// ── capture ────────────────────────────────────────────────────────────────

const TOOLSET_NAME_RE =
  /^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/;

const splitWords = (raw: string): string[] =>
  raw.trim() ? raw.trim().split(/\s+/) : [];

/** Capture the current sandbox state into a reusable artifact. Two backed
 * shapes: a standalone toolset (fresh: name + paths you choose) or a new
 * version of a toolbox you own (its own declared paths). */
async function captureFlow(api: AtelierApi, id: string): Promise<void> {
  const kind = await ui.select<"toolset" | "toolbox" | "back">({
    message: "Capture this sandbox as…",
    options: [
      {
        value: "toolset",
        label: "Toolset (fresh)",
        hint: "portable bundle of home paths (dotfiles/configs); referenced by ref in a spec",
      },
      {
        value: "toolbox",
        label: "Toolbox version",
        hint: "new version of a toolbox you own — managed, named, versioned, auto-injectable",
      },
      { value: "back", label: pc.dim("Back") },
    ],
  });
  if (kind === "toolset") await captureToolset(api, id);
  else if (kind === "toolbox") await captureToolboxVersion(api, id);
}

/** Fresh toolset capture: name + paths are mandatory; exclude globs and
 * secret-scan overrides are optional. */
async function captureToolset(api: AtelierApi, id: string): Promise<void> {
  const name = await ui.text({
    message: "Toolset name",
    placeholder: "my-dotfiles",
    validate: (v) =>
      !v.trim()
        ? "required"
        : TOOLSET_NAME_RE.test(v.trim())
          ? undefined
          : "lowercase alnum + . _ - , slash-separated (e.g. team/pi)",
  });
  if (!name.trim()) return;
  const paths = splitWords(
    await ui.text({
      message: "Paths to capture (space-separated, home-relative)",
      placeholder: ".config/nvim .local/share/foo .zshrc",
      validate: (v) => (v.trim() ? undefined : "at least one path required"),
    }),
  );
  if (paths.length === 0) return;
  const exclude = splitWords(
    await ui.text({
      message: "Exclude globs (optional, space-separated)",
      placeholder: "**/*.log **/cache/**",
      defaultValue: "",
    }),
  );
  const overrides = splitWords(
    await ui.text({
      message: "Override paths to allow past the secret scan (optional)",
      placeholder: ".config/gh/hosts.yml",
      defaultValue: "",
    }),
  );
  const s = ui.spinner();
  s.start("Capturing toolset…");
  try {
    const job = unwrap(
      await api.v1.sandboxes({ id }).toolsets.capture.post({
        name: name.trim(),
        paths,
        exclude,
        overrides,
      }),
    );
    const ref = await waitForJob<{ ref: string }>(api, job);
    s.stop(`Captured ${ref.ref}`);
  } catch (err) {
    s.stop("Capture failed");
    ui.note(err instanceof Error ? err.message : String(err));
  }
}

/** Toolbox-version capture: pick a toolbox you own, describe it; the server
 * captures the toolbox's OWN declared paths (no path entry here). */
async function captureToolboxVersion(
  api: AtelierApi,
  id: string,
): Promise<void> {
  const all = await gatherToolboxes(api).catch(() => []);
  const capturable = all.filter((t) => t.paths.length > 0);
  if (capturable.length === 0) {
    ui.note(
      "No toolbox with capturable paths. Create one first (`atelier toolbox create`).",
    );
    return;
  }
  const tbId = await ui.select<string | typeof BACK>({
    message: "Capture a version of which toolbox?",
    options: [
      ...capturable.map((t) => ({
        value: t.id,
        label: t.slug,
        hint: `${t.paths.length} path(s) · ${toolboxHint(t)}`,
      })),
      { value: BACK, label: pc.dim("Back") },
    ],
  });
  if (tbId === BACK) return;
  const description = await ui.text({
    message: "Version description",
    placeholder: "add nvim + zsh config",
    validate: (v) => (v.trim() ? undefined : "required"),
  });
  if (!description.trim()) return;
  const s = ui.spinner();
  s.start("Capturing toolbox version…");
  try {
    const job = unwrap(
      await api.api.toolboxes({ id: tbId }).versions.capture.post({
        sandboxId: id,
        description: description.trim(),
      }),
    );
    const v = await waitForJob<{ label: string; ref: string }>(api, job);
    s.stop(`Captured v${v.label}`);
  } catch (err) {
    s.stop("Capture failed");
    ui.note(err instanceof Error ? err.message : String(err));
  }
}

/** Block on a sandbox-create job while streaming its boot progress log. */
async function bootWithLogs(
  api: AtelierApi,
  job: JobRecord,
): Promise<CreateSandboxResponse> {
  line(pc.dim("booting…"));
  let printed = 0;
  let current = job;
  const flush = async () => {
    try {
      const { log } = unwrap(await api.v1.jobs({ id: current.id }).logs.get());
      if (log.length > printed) {
        for (const l of log.slice(printed).split("\n")) {
          if (l) line(pc.dim(`  ${l}`));
        }
        printed = log.length;
      }
    } catch {
      // Log endpoint is best-effort; keep polling status.
    }
  };
  while (current.status === "queued" || current.status === "running") {
    await flush();
    await new Promise((r) => setTimeout(r, 900));
    current = unwrap(await api.v1.jobs({ id: current.id }).get());
  }
  await flush();
  if (current.status !== "succeeded") {
    throw new ApiError(
      current.status === "canceled" ? 499 : 500,
      current.error ?? `boot ${current.status}`,
    );
  }
  return current.result as CreateSandboxResponse;
}

/** Spawn a new sandbox from within the cockpit: pick a core (image /
 * prebuild), layer on toolboxes, then boot with a live progress log. */
async function spawnFlow(api: AtelierApi): Promise<string | null> {
  const source = await ui.select<"image" | "prebuild" | "cancel">({
    message: "New sandbox from…",
    options: [
      {
        value: "prebuild",
        label: "Prebuild",
        hint: "boot from a repo snapshot you already baked — fast, deps ready",
      },
      {
        value: "image",
        label: "Base image",
        hint: "boot straight from a Docker image ref — empty, no repo",
      },
      { value: "cancel", label: pc.dim("Cancel") },
    ],
  });
  if (source === "cancel") return null;

  // ── 1. core source ──────────────────────────────────────────────────────
  let body: Record<string, unknown> | undefined;
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
        hint: prebuildHint(p),
      })),
    });
    body = {
      source: { snapshot: ref },
      resources: { vcpus: 2, memoryMb: 2048 },
    };
  }
  if (!body) return null;

  // ── 2. toolboxes ────────────────────────────────────────────────────────
  const toolboxes = await pickToolboxes(api);
  const finalBody = toolboxes.length > 0 ? { ...body, toolboxes } : body;

  // ── 3. boot (streaming the progress log) ────────────────────────────────
  const job = unwrap(
    // biome-ignore lint/suspicious/noExplicitAny: body is a validated spec union
    await api.v1.sandboxes.post(finalBody as any),
  );
  try {
    const result = await bootWithLogs(api, job);
    line(pc.green(`✓ ${result.id} ready`));
    return result.id;
  } catch (err) {
    line(pc.red("boot failed"));
    throw err;
  }
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
async function computeSshReady(api: AtelierApi): Promise<boolean> {
  try {
    const local = listLocalKeys();
    if (local.length === 0) return false;
    const remote = unwrap(await api.api["ssh-keys"].get());
    const registered = new Set(remote.map((k) => k.fingerprint));
    return local.some((k) => registered.has(k.fingerprint));
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
async function runAction(
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

/** The interactive cockpit loop — reused by `atelier browse` and by bare
 * `atelier` (no args). */
export async function browseInteractive(ctx: Ctx): Promise<void> {
  if (!ui.isInteractive()) {
    line(pc.red("browse needs an interactive terminal"));
    process.exit(1);
  }
  const api = ctx.api();
  const cfg = ctx.config();
  let sshReady = await computeSshReady(api);
  ui.intro(pc.cyan("atelier"));
  while (true) {
    const picked = await pickSandbox(api);
    if (!picked) break;
    if (picked === ACCOUNT) {
      await accountMenu(api);
      // SSH may have been set up / regenerated in the panel.
      sshReady = await computeSshReady(api);
      continue;
    }
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
      summarize(state, sshReady);
      inMenu = await runAction(api, cfg, id, state, sshReady);
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
