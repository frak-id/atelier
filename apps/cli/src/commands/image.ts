/** `atelier image` — base images: seed builds, Dockerfile builds, external
 * registrations, and build logs. */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import pc from "picocolors";
import { unwrap } from "../client.ts";
import type { Ctx } from "../context.ts";
import { line, printJson, statusColor, table } from "../output.ts";

export function registerImage(program: Command, ctx: Ctx): void {
  const image = program.command("image").description("Manage base images");

  image
    .command("ls")
    .description("List images")
    .action(async () => {
      const rows = unwrap(await ctx.api().v1.images.get());
      if (ctx.json) return printJson(rows);
      if (rows.length === 0) return line(pc.dim("no images"));
      table(
        ["NAME", "PROVENANCE", "STATUS", "REF"],
        rows.map((r) => [
          r.name,
          pc.dim(r.provenance),
          statusColor(r.status),
          r.ref ?? "",
        ]),
      );
    });

  image
    .command("templates")
    .description("List embedded seed templates")
    .action(async () => {
      const rows = unwrap(await ctx.api().v1.images.templates.get());
      if (ctx.json) return printJson(rows);
      if (rows.length === 0) return line(pc.dim("no image templates"));
      table(
        ["ID", "DESCRIPTION", "DEPENDS ON"],
        rows.map((r) => [r.id, r.description, r.dependsOn.join(",")]),
      );
    });

  image
    .command("build <seed>")
    .description("Build an embedded seed image (async)")
    .option("--force", "rebuild even if present")
    .action(async (seed: string, opts: { force?: boolean }) => {
      const record = unwrap(
        await ctx.api().v1.images.post({ seed, force: Boolean(opts.force) }),
      );
      if (ctx.json) return printJson(record);
      line(
        `${record.name}\t${statusColor(record.status)}\t(building — poll \`atelier image logs ${record.name}\`)`,
      );
    });

  image
    .command("build-dockerfile")
    .description("Build a user Dockerfile (async)")
    .requiredOption("--name <name>", "image name")
    .requiredOption("--file <path>", "Dockerfile path")
    .action(async (opts: { name: string; file: string }) => {
      const dockerfile = readFileSync(opts.file, "utf8");
      const record = unwrap(
        await ctx.api().v1.images.post({ name: opts.name, dockerfile }),
      );
      if (ctx.json) return printJson(record);
      line(
        `${record.name}\t${statusColor(record.status)}\t(building — poll \`atelier image logs ${record.name}\`)`,
      );
    });

  image
    .command("register <name> <ref>")
    .description("Register an externally-hosted image by reference")
    .action(async (name: string, ref: string) => {
      const record = unwrap(
        await ctx.api().v1.images.register.post({ name, ref }),
      );
      if (ctx.json) return printJson(record);
      line(
        `${record.name}\t${statusColor(record.status)}\t${record.ref ?? ""}`,
      );
    });

  image
    .command("logs <name>")
    .description("Print an image's build status + log")
    .action(async (name: string) => {
      const logs = unwrap(await ctx.api().v1.images({ name }).logs.get());
      if (ctx.json) return printJson(logs);
      line(`status: ${statusColor(logs.status)}`);
      process.stdout.write(logs.log);
    });

  image
    .command("rm <name>")
    .description("Delete an image")
    .action(async (name: string) => {
      await ctx.api().v1.images({ name }).delete().then(unwrap);
      line(`removed ${name}`);
    });
}
