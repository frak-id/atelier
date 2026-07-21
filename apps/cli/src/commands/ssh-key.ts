/** `atelier ssh-key` — manage the SSH public keys that grant access to sandbox
 * shells. `setup` is the one-shot: generate a local atelier keypair (if
 * missing) and register its public half on the server. */
import type { Command } from "commander";
import pc from "picocolors";
import { unwrap } from "../client.ts";
import type { Ctx } from "../context.ts";
import { age, fail, line, printJson, table } from "../output.ts";
import {
  ATELIER_KEY_PATH,
  defaultKeyLabel,
  generateAtelierKey,
  listLocalKeys,
  readLocalKey,
} from "../ssh-keys.ts";
import * as ui from "../ui.ts";

export function registerSshKey(program: Command, ctx: Ctx): void {
  const sshKey = program
    .command("ssh-key")
    .description("Manage SSH keys for sandbox access");

  sshKey
    .command("setup")
    .description("Generate a local atelier SSH key and register it remotely")
    .action(async () => {
      const api = ctx.api();
      const interactive = ui.isInteractive();
      if (interactive) ui.intro(pc.cyan("atelier ssh-key setup"));

      const s = interactive ? ui.spinner() : null;
      s?.start("Ensuring local key…");
      const local = await generateAtelierKey();
      s?.message("Checking server registration…");
      const remote = unwrap(await api.api["ssh-keys"].get());
      const already = remote.find((k) => k.fingerprint === local.fingerprint);
      if (already) {
        s?.stop("Key already registered.");
        const msg = `${pc.green("✓")} ${local.fingerprint} already registered as "${already.name}"`;
        if (interactive) ui.outro(msg);
        else line(msg);
        return;
      }
      s?.message("Registering…");
      const created = unwrap(
        await api.api["ssh-keys"].post({
          publicKey: local.publicKey,
          name: defaultKeyLabel(),
          type: "generated",
        }),
      );
      s?.stop("Registered.");
      if (ctx.json) return printJson(created);
      const summary = [
        `${pc.green("✓")} registered ${created.fingerprint}`,
        `  private key: ${pc.dim(ATELIER_KEY_PATH)}`,
        `  ${pc.dim("`atelier ssh <id>` will use it automatically.")}`,
      ].join("\n");
      if (interactive) ui.outro(summary);
      else line(summary);
    });

  sshKey
    .command("ls")
    .description("List registered SSH keys (★ = present locally)")
    .action(async () => {
      const remote = unwrap(await ctx.api().api["ssh-keys"].get());
      if (ctx.json) return printJson(remote);
      if (remote.length === 0) {
        return line(pc.dim("no registered keys — run `atelier ssh-key setup`"));
      }
      const localFps = new Set(listLocalKeys().map((k) => k.fingerprint));
      table(
        ["", "NAME", "FINGERPRINT", "TYPE", "AGE"],
        remote.map((k) => [
          localFps.has(k.fingerprint) ? pc.green("★") : " ",
          k.name,
          k.fingerprint,
          pc.dim(k.type),
          age(k.createdAt),
        ]),
      );
    });

  sshKey
    .command("rm <id>")
    .description("Remove a registered SSH key")
    .action(async (id: string) => {
      await ctx.api().api["ssh-keys"]({ id }).delete().then(unwrap);
      line(`removed ${id}`);
    });

  sshKey
    .command("register <pubkeyPath>")
    .description("Register an existing public key file on the server")
    .option("--name <name>", "label for the key")
    .action(async (pubkeyPath: string, opts: { name?: string }) => {
      const key = readLocalKey(pubkeyPath);
      if (!key) fail(`not a valid public key: ${pubkeyPath}`);
      const created = unwrap(
        await ctx.api().api["ssh-keys"].post({
          publicKey: key.publicKey,
          name: opts.name ?? `atelier:${pubkeyPath}`,
          type: "uploaded",
        }),
      );
      if (ctx.json) return printJson(created);
      line(
        `${pc.green("✓")} registered ${created.fingerprint} as "${created.name}"`,
      );
    });
}
