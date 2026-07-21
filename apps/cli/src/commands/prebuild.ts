/** `atelier prebuild` — content-addressed repo/build snapshots used as boot
 * sources. */
import type { PrebuildSpec } from "@atelier/spec";
import type { Command } from "commander";
import pc from "picocolors";
import { unwrap } from "../client.ts";
import type { Ctx } from "../context.ts";
import { detectGitRepo } from "../git.ts";
import { age, line, printJson, table } from "../output.ts";
import * as ui from "../ui.ts";
import { readJsonc } from "../util.ts";
import {
  createPrebuildFromArgs,
  createPrebuildInteractive,
} from "./prebuild-create.ts";
import { runPrebuild } from "./sandbox.ts";

const collect = (v: string, acc: string[]): string[] => {
  acc.push(v);
  return acc;
};

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
    .command("create")
    .description(
      "Bake a prebuild from a git repo + branch (interactive, or fully flagged)",
    )
    .option("--repo <url>", "clone URL (default: this repo's origin)")
    .option("--branch <name>", "branch to bake (default: current branch)")
    .option("--image <ref>", "base image to boot from")
    .option("--clone-path <path>", "where to clone inside the sandbox")
    .option(
      "--build <cmd>",
      "setup command run in the repo dir (repeatable; disables auto-detect)",
      collect,
      [],
    )
    .option("--no-detect", "skip best-effort setup-command detection")
    .option("--force", "bypass the content-hash cache")
    .action(
      async (opts: {
        repo?: string;
        branch?: string;
        image?: string;
        clonePath?: string;
        build: string[];
        detect?: boolean;
        force?: boolean;
      }) => {
        const api = ctx.api();
        const detected = detectGitRepo();
        // Interactive TTY (and not --json): drive the multi-step flow, seeded
        // from flags + the detected checkout. Otherwise bake straight from
        // flags, failing fast on anything unresolved.
        if (ui.isInteractive() && !ctx.json) {
          await createPrebuildInteractive(api, {
            repo: opts.repo ?? detected?.url,
            branch: opts.branch ?? detected?.branch,
            image: opts.image,
            clonePath: opts.clonePath,
            gitRepo: opts.detect === false ? undefined : detected,
            force: opts.force,
          });
          return;
        }
        const ref = await createPrebuildFromArgs(api, {
          repo: opts.repo ?? detected?.url,
          branch: opts.branch ?? detected?.branch,
          image: opts.image,
          clonePath: opts.clonePath,
          build: opts.build,
          detect: opts.detect === false ? undefined : detected,
          force: opts.force,
        });
        if (ctx.json) return printJson(ref);
        line(`${ref.ref}\t${ref.hash}`);
      },
    );

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
