/** `atelier context` — flip the CLI between named servers (e.g. a hosted
 * `default` and a `local` Docker one) without re-authing each time. Each
 * context is a `{ baseUrl, apiKey }` pair; `use` switches the active one. */
import type { Command } from "commander";
import pc from "picocolors";
import {
  currentContext,
  listContexts,
  removeContext,
  upsertContext,
  useContext,
} from "../config.ts";
import type { Ctx } from "../context.ts";
import { fail, line, printJson, table } from "../output.ts";

const mask = (key: string): string =>
  key ? `${key.slice(0, 6)}…${key.slice(-4)}` : pc.dim("(unset)");

export function registerContext(program: Command, ctx: Ctx): void {
  const context = program
    .command("context")
    .aliases(["ctx"])
    .description("Switch between named servers (remote / local)")
    .action(() => listAction(ctx));

  context
    .command("ls")
    .alias("list")
    .description("List contexts")
    .action(() => listAction(ctx));

  context
    .command("current")
    .description("Print the active context name")
    .action(() => line(currentContext()));

  context
    .command("use <name>")
    .description("Switch the active context")
    .action((name: string) => {
      try {
        useContext(name);
        line(`switched to ${pc.bold(name)}`);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  context
    .command("add <name>")
    .description("Create/replace a context and switch to it")
    .requiredOption("--url <baseUrl>", "server base URL")
    .option("--key <apiKey>", "API key (atl_… / JWT)", "")
    .option("--no-use", "create without switching to it")
    .action(
      (name: string, opts: { url: string; key: string; use: boolean }) => {
        if (!/^https?:\/\//.test(opts.url.trim())) {
          fail("--url must start with http:// or https://");
        }
        upsertContext(
          name,
          { baseUrl: opts.url.trim(), apiKey: opts.key.trim() },
          opts.use,
        );
        line(
          `saved context ${pc.bold(name)}${opts.use ? " (now active)" : ""}`,
        );
      },
    );

  context
    .command("rm <name>")
    .description("Remove a context")
    .action((name: string) => {
      try {
        removeContext(name);
        line(`removed context ${name}`);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });
}

function listAction(ctx: Ctx): void {
  const rows = listContexts();
  if (ctx.json) {
    printJson(rows.map(({ apiKey: _apiKey, ...r }) => r));
    return;
  }
  if (rows.length === 0) {
    line(pc.dim("no contexts — run `atelier login`"));
    return;
  }
  table(
    ["", "NAME", "BASE URL", "KEY"],
    rows.map((r) => [
      r.current ? pc.green("*") : " ",
      r.current ? pc.bold(r.name) : r.name,
      r.baseUrl || pc.dim("(unset)"),
      mask(r.apiKey),
    ]),
  );
}
