/** `atelier jobs` — the durable long-op queue (prebuild bakes, toolset
 * build/capture, sandbox lifecycle). List, inspect, cancel, or stream. */
import type { Command } from "commander";
import pc from "picocolors";
import { type JobRecord, unwrap } from "../client.ts";
import type { Ctx } from "../context.ts";
import { age, fail, line, printJson, statusColor, table } from "../output.ts";

function jobRow(j: JobRecord): string[] {
  return [
    j.id,
    j.kind,
    statusColor(j.status),
    j.target ?? "-",
    age(j.updatedAt),
  ];
}

export function registerJobs(program: Command, ctx: Ctx): void {
  const jobs = program.command("jobs").description("Long-running op queue");

  jobs
    .command("ls")
    .description("List jobs")
    .option("--limit <n>", "max rows (default 200)")
    .action(async (opts: { limit?: string }) => {
      const limit = opts.limit ? Number(opts.limit) : undefined;
      const rows = unwrap(
        await ctx.api().v1.jobs.get({
          query: limit ? { limit } : {},
        }),
      );
      if (ctx.json) return printJson(rows);
      if (rows.length === 0) return line(pc.dim("no jobs"));
      table(["ID", "KIND", "STATUS", "TARGET", "AGE"], rows.map(jobRow));
    });

  jobs
    .command("get <id>")
    .description("Inspect a job")
    .action(async (id: string) => {
      const job = unwrap(await ctx.api().v1.jobs({ id }).get());
      if (ctx.json) return printJson(job);
      line(`${pc.bold(job.id)}  ${job.kind}  [${statusColor(job.status)}]`);
      if (job.target) line(`  target: ${job.target}`);
      if (job.error) line(`  error:  ${pc.red(job.error)}`);
      if (job.result !== undefined) {
        line(`  result: ${JSON.stringify(job.result)}`);
      }
      line(`  created ${job.createdAt}  updated ${job.updatedAt}`);
    });

  jobs
    .command("cancel <id>")
    .description("Cancel a queued/running job")
    .action(async (id: string) => {
      const job = unwrap(await ctx.api().v1.jobs({ id }).cancel.post());
      if (ctx.json) return printJson(job);
      line(`canceled ${id} [${statusColor(job.status)}]`);
    });

  jobs
    .command("watch")
    .description("Stream job events (SSE) until Ctrl-C")
    .action(async () => {
      const cfg = ctx.config();
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      let res: Response;
      try {
        res = await fetch(`${cfg.baseUrl}/v1/jobs/events`, {
          headers: {
            authorization: `Bearer ${cfg.apiKey}`,
            accept: "text/event-stream",
          },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        fail(err instanceof Error ? err.message : String(err));
      }
      if (!res.ok || !res.body) fail(`jobs watch failed (HTTP ${res.status})`);
      line(pc.dim("watching jobs — Ctrl-C to stop"));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const dataLine = chunk
              .split("\n")
              .find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            try {
              const job = JSON.parse(dataLine.slice(5).trim()) as JobRecord;
              if (ctx.json) {
                printJson(job);
              } else {
                line(
                  `${new Date().toLocaleTimeString()}  ${statusColor(job.status).padEnd(20)} ${job.kind} ${pc.dim(job.target ?? "")}`,
                );
              }
            } catch {
              // skip keep-alives / non-JSON frames
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          fail(err instanceof Error ? err.message : String(err));
        }
      }
    });
}
