#!/usr/bin/env node
/**
 * `atelier` — the typed reference client for the Atelier server API. Command
 * routing + help via commander; interactive flows via @clack/prompts; every
 * backend call goes through the Eden Treaty client (`client.ts`).
 *
 * Bare `atelier` (no args) is smart: it runs first-time setup when nothing is
 * configured, otherwise it drops you into the interactive sandbox cockpit.
 */
import { Command } from "commander";
import { ApiError } from "./client.ts";
import { browseInteractive, registerBrowse } from "./commands/browse.ts";
import { registerConfig } from "./commands/config.ts";
import { registerContext } from "./commands/context.ts";
import { registerImage } from "./commands/image.ts";
import { registerJobs } from "./commands/jobs.ts";
import { registerLocal } from "./commands/local.ts";
import { registerAuth, runSetup } from "./commands/login.ts";
import { registerPrebuild } from "./commands/prebuild.ts";
import { registerSandbox } from "./commands/sandbox.ts";
import { registerSecret } from "./commands/secret.ts";
import { registerSshKey } from "./commands/ssh-key.ts";
import { registerToolbox } from "./commands/toolbox.ts";
import { registerToolset } from "./commands/toolset.ts";
import { registerWhoami } from "./commands/whoami.ts";
import { loadConfig } from "./config.ts";
import { createCtx } from "./context.ts";
import { fail } from "./output.ts";
import { isInteractive } from "./ui.ts";

const ctx = createCtx();
const program = new Command();

program
  .name("atelier")
  .description("Client for the Atelier sandbox runtime API")
  .version("3.0.0")
  .option("--json", "machine-readable JSON output")
  .hook("preAction", (thisCommand) => {
    ctx.json = Boolean(thisCommand.opts().json);
  })
  // Bare invocation: set up if unconfigured, else open the cockpit.
  .action(async () => {
    if (!isInteractive()) return program.help();
    if (!loadConfig().apiKey) {
      await runSetup();
      // Bail if setup was cancelled; otherwise fall through into the cockpit.
      if (!loadConfig().apiKey) return;
    }
    return browseInteractive(ctx);
  });

registerBrowse(program, ctx);
registerSandbox(program, ctx);
registerJobs(program, ctx);
registerPrebuild(program, ctx);
registerImage(program, ctx);
registerToolset(program, ctx);
registerToolbox(program, ctx);
registerSshKey(program, ctx);
registerSecret(program, ctx);
registerWhoami(program, ctx);
registerAuth(program, ctx);
registerConfig(program, ctx);
registerContext(program, ctx);
registerLocal(program, ctx);

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof ApiError) fail(`${err.message} (HTTP ${err.status})`);
  fail(err instanceof Error ? err.message : String(err));
});
