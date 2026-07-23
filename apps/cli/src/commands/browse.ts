/** `atelier browse` (alias `i`) — the interactive sandbox cockpit: pick a
 * sandbox (or spawn a new one), then drive it (shell, browser, attach,
 * processes, logs, exec, pause/resume, remove). An Account entry exposes
 * identity + SSH readiness and one-shot SSH setup/regenerate. Advanced,
 * rarely-used actions (expose/env/sync/snapshot/add-process) live as scriptable
 * subcommands to keep this menu lean.
 *
 * The cockpit is split across `./browse/*`: this file owns the sandbox picker
 * and the top-level loop; each panel (account, contexts, images, prebuilds,
 * spawn, per-sandbox actions) lives in its own module. */
import type { SandboxState } from "@atelier/spec";
import type { Command } from "commander";
import pc from "picocolors";
import { type AtelierApi, unwrap } from "../client.ts";
import { currentContext } from "../config.ts";
import { type Ctx, createCtx } from "../context.ts";
import { age, line, statusColor } from "../output.ts";
import * as ui from "../ui.ts";
import { accountMenu } from "./browse/account.ts";
import { computeSshReady, runAction, summarize } from "./browse/actions.ts";
import { contextsMenu, isBypassed } from "./browse/contexts.ts";
import { imagesMenu } from "./browse/images.ts";
import {
  computeGitNudge,
  type GitNudge,
  prebuildsMenu,
} from "./browse/prebuilds.ts";
import { spawnFlow } from "./browse/spawn.ts";
import { gitAuthMenu } from "./local.ts";
import { describeAnnotations } from "./sandbox-helpers.ts";

const NEW = "__new__";
const QUIT = "__quit__";
const FILTER = "__filter__";
const ACCOUNT = "__account__";
const CONTEXTS = "__contexts__";
const GITAUTH = "__gitauth__";
const IMAGES = "__images__";
const PREBUILDS = "__prebuilds__";

/** Pick a sandbox from the live list, with an optional name filter and entries
 * to spawn a new one or quit. Returns an id, `NEW`, or null (quit). */
async function pickSandbox(
  api: AtelierApi,
  local: boolean,
  filter?: string,
  gitNudge?: GitNudge,
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
      { value: CONTEXTS, label: pc.dim("Contexts"), hint: currentContext() },
      ...(local
        ? [
            {
              value: GITAUTH,
              label: pc.dim("GitHub auth"),
              hint: "private-repo token for sandboxes",
            },
          ]
        : []),
      { value: IMAGES, label: pc.dim("Base images") },
      {
        value: PREBUILDS,
        label: gitNudge ? `Prebuilds ${pc.green("✦")}` : pc.dim("Prebuilds"),
        hint: gitNudge
          ? pc.green(`bake ${gitNudge.label} — no prebuild yet`)
          : undefined,
      },
      { value: ACCOUNT, label: pc.dim("Account & SSH") },
      { value: QUIT, label: pc.dim("Quit") },
    ],
  });
  if (choice === QUIT) return null;
  if (choice === NEW) return NEW;
  if (choice === FILTER) {
    const term = await ui.text({ message: "Filter", placeholder: "repo / id" });
    return pickSandbox(api, local, term.trim() || undefined, gitNudge);
  }
  return choice;
}

/** The interactive cockpit loop — reused by `atelier browse` and by bare
 * `atelier` (no args). */
export async function browseInteractive(ctx: Ctx): Promise<void> {
  if (!ui.isInteractive()) {
    line(pc.red("browse needs an interactive terminal"));
    process.exit(1);
  }
  let api = ctx.api();
  let cfg = ctx.config();
  let sshReady = await computeSshReady(api);
  let local = await isBypassed(api);
  ui.intro(pc.cyan("atelier"));
  while (true) {
    const gitNudge = (await computeGitNudge(api)) ?? undefined;
    const picked = await pickSandbox(api, local, undefined, gitNudge);
    if (!picked) break;
    if (picked === CONTEXTS) {
      if (await contextsMenu()) {
        // Rebuild the client against the newly-active context.
        try {
          const next = createCtx();
          api = next.api();
          cfg = next.config();
          sshReady = await computeSshReady(api);
          local = await isBypassed(api);
        } catch (err) {
          ui.note(
            `Switched, but this context isn't usable: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      continue;
    }
    if (picked === GITAUTH) {
      await gitAuthMenu();
      continue;
    }
    if (picked === IMAGES) {
      await imagesMenu(api);
      continue;
    }
    if (picked === PREBUILDS) {
      await prebuildsMenu(api);
      continue;
    }
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
