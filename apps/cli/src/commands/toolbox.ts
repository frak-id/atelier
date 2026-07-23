/** `atelier toolbox` — org/user tool recipes (control plane, `/api/toolboxes`)
 * with their captured version history. */
import type { ToolboxConfigInput, ToolboxConfigPatch } from "@atelier/spec";
import type { Command } from "commander";
import pc from "picocolors";
import { unwrap, waitForJob } from "../client.ts";
import type { Ctx } from "../context.ts";
import { fail, line, printJson, table } from "../output.ts";
import { collect } from "../util.ts";

/** Resolve `--org <id>` → `org:<id>` or `--mine` → `user`; nothing → caller's
 * own (server default). */
function owner(opts: { org?: string; mine?: boolean }): string | undefined {
  if (opts.org) {
    if (opts.mine) fail("use only one of --mine or --org");
    return `org:${opts.org}`;
  }
  return opts.mine ? "user" : undefined;
}

export function registerToolbox(program: Command, ctx: Ctx): void {
  const toolbox = program.command("toolbox").description("Manage toolboxes");

  toolbox
    .command("ls")
    .description("List toolboxes")
    .option("--mine", "only your own toolboxes")
    .option("--org <id>", "an org's toolboxes")
    .action(async (opts: { mine?: boolean; org?: string }) => {
      const o = owner(opts);
      const rows = unwrap(
        await ctx.api().api.toolboxes.get({ query: o ? { owner: o } : {} }),
      );
      if (ctx.json) return printJson(rows);
      if (rows.length === 0) return line(pc.dim("no toolboxes"));
      table(
        ["ID", "SLUG", "INJECT", "DESCRIPTION"],
        rows.map((t) => [
          t.id,
          t.slug,
          t.autoInject ? pc.green("auto") : pc.dim("manual"),
          t.description,
        ]),
      );
    });

  toolbox
    .command("create <slug>")
    .description("Create a toolbox")
    .requiredOption("--desc <text>", "description")
    .option("--build <cmd>", "build step (repeatable)", collect, [])
    .option("--path <path>", "captured path (repeatable)", collect, [])
    .option("--source-image <img>", "source image")
    .option("--source-snapshot <ref>", "source snapshot")
    .option("--mine", "create under your own account")
    .option("--org <id>", "create under an org")
    .option("--disabled", "do not auto-inject")
    .action(
      async (
        slug: string,
        opts: {
          desc: string;
          build: string[];
          path: string[];
          sourceImage?: string;
          sourceSnapshot?: string;
          mine?: boolean;
          org?: string;
          disabled?: boolean;
        },
      ) => {
        if (opts.sourceImage && opts.sourceSnapshot) {
          fail("use only one of --source-image or --source-snapshot");
        }
        const input: ToolboxConfigInput = {
          slug,
          description: opts.desc,
          build: opts.build,
          paths: opts.path,
          ...(opts.sourceImage
            ? { source: { image: opts.sourceImage } }
            : opts.sourceSnapshot
              ? { source: { snapshot: opts.sourceSnapshot } }
              : {}),
          ...(opts.disabled ? { autoInject: false } : {}),
        };
        const o = owner(opts);
        const created = unwrap(
          await ctx
            .api()
            .api.toolboxes.post(input, { query: o ? { owner: o } : {} }),
        );
        if (ctx.json) return printJson(created);
        line(`${created.id}\t${created.slug}`);
      },
    );

  toolbox
    .command("set <id>")
    .description("Update a toolbox")
    .option("--desc <text>", "description")
    .option("--build <cmd>", "build step (repeatable, replaces)", collect, [])
    .option(
      "--path <path>",
      "captured path (repeatable, replaces)",
      collect,
      [],
    )
    .option("--enable", "enable auto-inject")
    .option("--disable", "disable auto-inject")
    .action(
      async (
        id: string,
        opts: {
          desc?: string;
          build: string[];
          path: string[];
          enable?: boolean;
          disable?: boolean;
        },
      ) => {
        if (opts.enable && opts.disable) {
          fail("use only one of --enable or --disable");
        }
        const patch: ToolboxConfigPatch = {
          ...(opts.desc !== undefined ? { description: opts.desc } : {}),
          ...(opts.build.length > 0 ? { build: opts.build } : {}),
          ...(opts.path.length > 0 ? { paths: opts.path } : {}),
          ...(opts.enable ? { autoInject: true } : {}),
          ...(opts.disable ? { autoInject: false } : {}),
        };
        const updated = unwrap(
          await ctx.api().api.toolboxes({ id }).patch(patch),
        );
        if (ctx.json) return printJson(updated);
        line(`${updated.id}\t${updated.slug}`);
      },
    );

  toolbox
    .command("rm <id>")
    .description("Delete a toolbox")
    .action(async (id: string) => {
      await ctx.api().api.toolboxes({ id }).delete().then(unwrap);
      line(`removed ${id}`);
    });

  toolbox
    .command("versions <id>")
    .description("List a toolbox's captured versions")
    .action(async (id: string) => {
      const list = unwrap(await ctx.api().api.toolboxes({ id }).versions.get());
      if (ctx.json) return printJson(list);
      if (list.versions.length === 0) return line(pc.dim("no versions"));
      table(
        ["", "LABEL", "ID", "REF", "KIND", "DESCRIPTION"],
        list.versions.map((v) => [
          v.id === list.activeVersionId ? pc.green("*") : " ",
          `v${v.label}`,
          v.id,
          v.ref,
          v.provenance.kind,
          v.description,
        ]),
      );
    });

  const version = toolbox
    .command("version")
    .description("Manage toolbox versions");

  version
    .command("capture <id> <sandboxId>")
    .description("Capture a version from a live sandbox (blocks on the job)")
    .requiredOption("--desc <text>", "description")
    .action(async (id: string, sandboxId: string, opts: { desc: string }) => {
      const job = unwrap(
        await ctx
          .api()
          .api.toolboxes({ id })
          .versions.capture.post({ sandboxId, description: opts.desc }),
      );
      const v = await waitForJob<{ id: string; label: string; ref: string }>(
        ctx.api(),
        job,
      );
      if (ctx.json) return printJson(v);
      line(`v${v.label}\t${v.id}\t${v.ref}`);
    });

  version
    .command("pin <id> <versionId>")
    .description("Pin a toolbox to a version")
    .action(async (id: string, versionId: string) => {
      await ctx
        .api()
        .api.toolboxes({ id })
        ["active-version"].put({ versionId })
        .then(unwrap);
      line(`pinned ${versionId} on ${id}`);
    });

  version
    .command("unpin <id>")
    .description("Unpin a toolbox (float to latest recipe)")
    .action(async (id: string) => {
      await ctx
        .api()
        .api.toolboxes({ id })
        ["active-version"].put({ versionId: null })
        .then(unwrap);
      line(`unpinned ${id}`);
    });

  version
    .command("rm <id> <versionId>")
    .description("Delete a toolbox version")
    .action(async (id: string, versionId: string) => {
      await ctx
        .api()
        .api.toolboxes({ id })
        .versions({ versionId })
        .delete()
        .then(unwrap);
      line(`removed ${versionId}`);
    });
}
