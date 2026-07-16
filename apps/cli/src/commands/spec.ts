/** `atelier spec` — saved SandboxSpecs (named, reusable sandbox shapes) and a
 * one-shot `spawn` to boot from one. */
import type { SandboxSpec } from "@atelier/spec";
import type { Command } from "commander";
import pc from "picocolors";
import { unwrap } from "../client.ts";
import type { Ctx } from "../context.ts";
import { age, fail, line, printJson, table } from "../output.ts";
import { readJsonc } from "../util.ts";

export function registerSpec(program: Command, ctx: Ctx): void {
  const spec = program
    .command("spec")
    .description("Manage saved sandbox specs");

  spec
    .command("ls")
    .description("List saved specs")
    .action(async () => {
      const rows = unwrap(await ctx.api().api["saved-specs"].get());
      if (ctx.json) return printJson(rows);
      if (rows.length === 0) return line(pc.dim("no saved specs"));
      table(
        ["ID", "NAME", "SCOPE", "AGE"],
        rows.map((s) => [
          s.id,
          s.name,
          s.orgId ? pc.dim(`org:${s.orgId}`) : pc.dim("-"),
          age(s.updatedAt),
        ]),
      );
    });

  spec
    .command("get <id>")
    .description("Print a saved spec")
    .action(async (id: string) => {
      const saved = unwrap(await ctx.api().api["saved-specs"]({ id }).get());
      if (ctx.json) return printJson(saved);
      line(`${pc.bold(saved.name)}  ${pc.dim(saved.id)}`);
      line(JSON.stringify(saved.spec, null, 2));
    });

  spec
    .command("save <name>")
    .description("Save a spec file under a name")
    .requiredOption("--file <path>", "spec file (JSONC)")
    .option("--org <id>", "org to save under (defaults to your first org)")
    .action(async (name: string, opts: { file: string; org?: string }) => {
      const body = readJsonc<SandboxSpec>(opts.file);
      // Saved specs are listed by org membership, so an org is required for
      // the spec to be visible; default to the caller's first org.
      let orgId = opts.org;
      if (!orgId) {
        const me = unwrap(await ctx.api().api.me.get());
        orgId = me.organizations[0]?.id;
        if (!orgId) fail("no org found; pass --org <id>");
      }
      const created = unwrap(
        await ctx.api().api["saved-specs"].post({ name, spec: body, orgId }),
      );
      if (ctx.json) return printJson(created);
      line(`${created.id}\t${created.name}`);
    });

  spec
    .command("rm <id>")
    .description("Delete a saved spec")
    .action(async (id: string) => {
      await ctx.api().api["saved-specs"]({ id }).delete().then(unwrap);
      line(`removed ${id}`);
    });

  spec
    .command("spawn <id>")
    .description("Boot a sandbox from a saved spec")
    .action(async (id: string) => {
      const api = ctx.api();
      const saved = unwrap(await api.api["saved-specs"]({ id }).get());
      const result = unwrap(await api.v1.sandboxes.post(saved.spec));
      if (ctx.json) return printJson(result);
      line(pc.bold(result.id));
      for (const u of result.urls) line(`  ${u.name}: ${pc.cyan(u.url)}`);
    });
}
