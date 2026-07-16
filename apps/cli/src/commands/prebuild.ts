/** `atelier prebuild` — content-addressed repo/build snapshots used as boot
 * sources. */
import type { PrebuildSpec } from "@atelier/spec";
import type { Command } from "commander";
import pc from "picocolors";
import { unwrap } from "../client.ts";
import type { Ctx } from "../context.ts";
import { age, line, printJson, table } from "../output.ts";
import { readJsonc } from "../util.ts";
import { runPrebuild } from "./sandbox.ts";

export function registerPrebuild(program: Command, ctx: Ctx): void {
  const prebuild = program
    .command("prebuild")
    .description("Manage prebuild snapshots");

  prebuild
    .command("run <file>")
    .description("Bake a prebuild spec into a snapshot (blocks on the job)")
    .option("--force", "bypass the content-hash cache")
    .action(async (file: string, opts: { force?: boolean }) => {
      const spec = readJsonc<PrebuildSpec>(file);
      const ref = await runPrebuild(ctx.api(), spec, Boolean(opts.force));
      if (ctx.json) return printJson(ref);
      line(`${ref.ref}\t${ref.hash}`);
    });

  prebuild
    .command("ls")
    .description("List stored prebuilds")
    .action(async () => {
      const rows = unwrap(await ctx.api().v1.prebuilds.get());
      if (ctx.json) return printJson(rows);
      if (rows.length === 0) return line(pc.dim("no prebuilds"));
      table(
        ["REF", "HASH", "USE", "AGE"],
        rows.map((r) => [
          r.ref,
          r.hash,
          r.inUse ? pc.green("in-use") : pc.dim("unused"),
          age(r.createdAt),
        ]),
      );
    });

  prebuild
    .command("rm <ref>")
    .description("Delete a prebuild snapshot")
    .action(async (ref: string) => {
      await ctx.api().v1.prebuilds({ ref }).delete().then(unwrap);
      line(`removed ${ref}`);
    });
}
