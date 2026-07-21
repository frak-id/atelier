/** `atelier toolset` — squashfs tool overlays: build from a recipe, capture
 * from a live sandbox, publish, list, remove. */
import type { ToolsetBuildRequest, ToolsetCaptureRequest } from "@atelier/spec";
import type { Command } from "commander";
import pc from "picocolors";
import { unwrap, waitForJob } from "../client.ts";
import type { Ctx } from "../context.ts";
import { line, printJson, table } from "../output.ts";
import { readJsonc } from "../util.ts";

const collect = (v: string, acc: string[]): string[] => {
  acc.push(v);
  return acc;
};

export function registerToolset(program: Command, ctx: Ctx): void {
  const toolset = program
    .command("toolset")
    .description("Manage tool overlays");

  toolset
    .command("ls")
    .description("List toolsets")
    .action(async () => {
      const rows = unwrap(await ctx.api().v1.toolsets.get());
      if (ctx.json) return printJson(rows);
      if (rows.length === 0) return line(pc.dim("no toolsets"));
      table(
        ["NAME", "REF", "KIND", "VIS"],
        rows.map((e) => [
          e.name,
          e.ref,
          e.provenance.kind,
          e.private ? pc.yellow("private") : pc.green("public"),
        ]),
      );
    });

  toolset
    .command("build <file>")
    .description("Build a toolset from a recipe (blocks on the job)")
    .action(async (file: string) => {
      const req = readJsonc<ToolsetBuildRequest>(file);
      const job = unwrap(await ctx.api().v1.toolsets.post(req));
      const ref = await waitForJob<{ ref: string }>(ctx.api(), job);
      if (ctx.json) return printJson(ref);
      line(ref.ref);
    });

  toolset
    .command("capture <id> <name> [paths...]")
    .description("Capture paths from a live sandbox into a toolset")
    .option("--exclude <glob>", "exclude glob (repeatable)", collect, [])
    .option("--override <path>", "override path (repeatable)", collect, [])
    .action(
      async (
        id: string,
        name: string,
        paths: string[],
        opts: { exclude: string[]; override: string[] },
      ) => {
        if (paths.length === 0) {
          line(pc.red("toolset capture needs at least one path"));
          process.exit(1);
        }
        const req: ToolsetCaptureRequest = {
          name,
          paths,
          exclude: opts.exclude,
          overrides: opts.override,
        };
        const job = unwrap(
          await ctx.api().v1.sandboxes({ id }).toolsets.capture.post(req),
        );
        const ref = await waitForJob<{ ref: string }>(ctx.api(), job);
        if (ctx.json) return printJson(ref);
        line(ref.ref);
      },
    );

  toolset
    .command("publish <ref>")
    .description("Publish a toolset (make it public)")
    .action(async (ref: string) => {
      const entry = unwrap(await ctx.api().v1.toolsets.publish.post({ ref }));
      if (ctx.json) return printJson(entry);
      line(`published ${entry.name} (${entry.ref})`);
    });

  toolset
    .command("rm <ref>")
    .description("Remove a toolset")
    .action(async (ref: string) => {
      await ctx
        .api()
        .v1.toolsets.delete(undefined, { query: { ref } })
        .then(unwrap);
      line(`removed ${ref}`);
    });
}
