/** `atelier secret` — control-plane secrets injected into sandboxes at boot.
 * Values are write-only (the API never returns them). */
import type { Command } from "commander";
import pc from "picocolors";
import { unwrap } from "../client.ts";
import type { Ctx } from "../context.ts";
import { age, line, printJson, table } from "../output.ts";

export function registerSecret(program: Command, ctx: Ctx): void {
  const secret = program
    .command("secret")
    .description("Manage secrets (names only; values are write-only)");

  secret
    .command("ls")
    .description("List secret names")
    .option("--org <id>", "org-scoped secrets")
    .action(async (opts: { org?: string }) => {
      const rows = unwrap(
        await ctx
          .api()
          .api.secrets.get({ query: opts.org ? { orgId: opts.org } : {} }),
      );
      if (ctx.json) return printJson(rows);
      if (rows.length === 0) return line(pc.dim("no secrets"));
      table(
        ["NAME", "SCOPE", "AGE"],
        rows.map((s) => [
          s.name,
          s.orgId ? pc.dim(`org:${s.orgId}`) : pc.dim("personal"),
          age(s.updatedAt),
        ]),
      );
    });

  secret
    .command("set <name> <value>")
    .description("Create or overwrite a secret")
    .option("--org <id>", "store under an org")
    .action(async (name: string, value: string, opts: { org?: string }) => {
      const created = unwrap(
        await ctx.api().api.secrets.post({
          name,
          value,
          ...(opts.org ? { orgId: opts.org } : {}),
        }),
      );
      if (ctx.json) return printJson(created);
      line(`${pc.green("✓")} set ${name}`);
    });

  secret
    .command("rm <id>")
    .description("Delete a secret")
    .action(async (id: string) => {
      await ctx.api().api.secrets({ id }).delete().then(unwrap);
      line(`removed ${id}`);
    });
}
