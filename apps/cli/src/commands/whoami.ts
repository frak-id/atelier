/** `atelier whoami` — resolve the authenticated identity (works with API keys
 * and JWTs via `GET /api/me`). */
import type { Command } from "commander";
import pc from "picocolors";
import { unwrap } from "../client.ts";
import type { Ctx } from "../context.ts";
import { line, printJson } from "../output.ts";

export function registerWhoami(program: Command, ctx: Ctx): void {
  program
    .command("whoami")
    .description("Show the authenticated user")
    .action(async () => {
      const me = unwrap(await ctx.api().api.me.get());
      if (ctx.json) return printJson(me);
      line(`${pc.bold(me.username)}  ${pc.dim(me.email)}`);
      line(`id: ${me.id}`);
      if (me.organizations.length > 0) {
        line(
          `orgs: ${me.organizations.map((o) => `${o.name} ${pc.dim(`(${o.id})`)}`).join(", ")}`,
        );
      }
    });
}
