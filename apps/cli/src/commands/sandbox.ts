/** `atelier` sandbox lifecycle: up, ps, get, logs, exec, pause, resume, rm,
 * attach, ssh, sync, env, expose, snapshot, process. */
import type {
  AddProcessRequest,
  CreateSandboxResponse,
  PrebuildRepo,
  PrebuildSpec,
  ResumeRequest,
  SandboxSpec,
} from "@atelier/spec";
import type { Command } from "commander";
import pc from "picocolors";
import { attach } from "../attach.ts";
import { type AtelierApi, unwrap, waitForJob } from "../client.ts";
import type { Ctx } from "../context.ts";
import { age, fail, line, printJson, statusColor, table } from "../output.ts";
import { runInherit } from "../proc.ts";
import {
  collect,
  collectFiles,
  parseEnvPairs,
  readJsonc,
  splitRemote,
} from "../util.ts";
import { followLogs } from "./logs-follow.ts";
import { harnessOf, sshCommand } from "./sandbox-helpers.ts";

/** Authoring superset: a runtime spec plus the bake-only `build`/`repos` steps
 * that `--bake` extracts into a prebuild. */
type AuthoringSpec = SandboxSpec & { build?: string[]; repos?: PrebuildRepo[] };

interface UpOpts {
  spec?: string;
  fromSnapshot?: string;
  image?: string;
  vcpus?: string;
  memory?: string;
  bake?: boolean;
  toolset: string[];
  toolbox: string[];
}

function buildUpSpec(opts: UpOpts): SandboxSpec {
  if (opts.spec) return readJsonc<SandboxSpec>(opts.spec);
  if (!opts.fromSnapshot && !opts.image) {
    fail("up needs --spec <file>, --from-snapshot <ref>, or --image <ref>");
  }
  const vcpus = Number(opts.vcpus ?? "2");
  const memoryMb = Number(opts.memory ?? "2048");
  if (!Number.isFinite(vcpus) || !Number.isFinite(memoryMb)) {
    fail("--vcpus and --memory must be numbers");
  }
  return {
    source: opts.fromSnapshot
      ? { snapshot: opts.fromSnapshot }
      : { image: opts.image as string },
    resources: { vcpus, memoryMb },
  };
}

/** Dispatch a prebuild bake and block on the job, returning its snapshot ref. */
export async function runPrebuild(
  api: AtelierApi,
  spec: PrebuildSpec,
  force = false,
): Promise<{ ref: string; hash: string }> {
  const job = unwrap(await api.v1.prebuilds.post(spec, { query: { force } }));
  return waitForJob(api, job);
}

/** Resolve the spec to boot; with `--bake` the spec's `build`/`repos` are
 * hashed into a derived prebuild snapshot and the sandbox boots from that. */
async function resolveUpSpec(
  api: AtelierApi,
  opts: UpOpts,
): Promise<SandboxSpec> {
  if (!opts.bake) return buildUpSpec(opts);
  if (!opts.spec) fail("--bake requires --spec <file>");
  const { build, repos, ...sandbox } = readJsonc<AuthoringSpec>(opts.spec);
  if (!build?.length && !repos?.length) {
    fail("--bake needs build[] or repos in the spec file");
  }
  const prebuild: PrebuildSpec = { source: sandbox.source };
  if (build?.length) prebuild.build = build;
  if (repos?.length) prebuild.repos = repos;
  process.stderr.write("baking prebuild…\n");
  const ref = await runPrebuild(api, prebuild);
  process.stderr.write(`baked ${ref.ref}\n`);
  return { ...sandbox, source: { snapshot: ref.ref } };
}

function applyToolsets(spec: SandboxSpec, refs: string[]): SandboxSpec {
  if (refs.length === 0) return spec;
  return {
    ...spec,
    toolsets: [...(spec.toolsets ?? []), ...refs.map((ref) => ({ ref }))],
  };
}

export function registerSandbox(program: Command, ctx: Ctx): void {
  program
    .command("up")
    .description("Create a sandbox from a spec, snapshot, or image")
    .option("--spec <file>", "spec file (JSONC)")
    .option("--from-snapshot <ref>", "boot from a snapshot ref")
    .option("--image <ref>", "boot from an image ref")
    .option("--vcpus <n>", "vCPUs (default 2)")
    .option("--memory <mb>", "memory MB (default 2048)")
    .option("--bake", "bake the spec's build[]/repos into a prebuild first")
    .option("--toolset <ref>", "attach a toolset (repeatable)", collect, [])
    .option(
      "--toolbox <selector>",
      "select a toolbox tb/<owner>/<id>/<slug> (repeatable)",
      collect,
      [],
    )
    .action(async (opts: UpOpts) => {
      const api = ctx.api();
      const spec = applyToolsets(await resolveUpSpec(api, opts), opts.toolset);
      // `toolboxes` selectors ride alongside the spec on the create request
      // (the server resolves + merges them); they aren't part of SandboxSpec.
      const body =
        opts.toolbox.length > 0 ? { ...spec, toolboxes: opts.toolbox } : spec;
      // Spawn now answers 202 with a `sandbox-create` job; block on it so the
      // CLI keeps its "boot then print URLs" UX (job.result is the sandbox).
      const job = unwrap(await api.v1.sandboxes.post(body));
      const result = await waitForJob<CreateSandboxResponse>(api, job);
      if (ctx.json) return printJson(result);
      line(pc.bold(result.id));
      for (const u of result.urls) line(`  ${u.name}: ${pc.cyan(u.url)}`);
    });

  program
    .command("ps")
    .alias("ls")
    .description("List sandboxes")
    .action(async () => {
      const rows = unwrap(await ctx.api().v1.sandboxes.get());
      if (ctx.json) return printJson(rows);
      if (rows.length === 0) return line(pc.dim("no sandboxes"));
      table(
        ["ID", "STATUS", "HARNESS", "AGE"],
        rows.map((r) => [
          r.id,
          statusColor(r.status),
          harnessOf(r.annotations),
          age(r.createdAt),
        ]),
      );
    });

  program
    .command("get <id>")
    .description("Show a sandbox's status, processes, and URLs")
    .action(async (id: string) => {
      const state = unwrap(await ctx.api().v1.sandboxes({ id }).get());
      if (ctx.json) return printJson(state);
      line(`${pc.bold(state.id)}  [${statusColor(state.status)}]`);
      for (const p of state.processes) {
        const tags = [p.primary ? "primary" : "", p.ready ? "ready" : ""]
          .filter(Boolean)
          .join(",");
        line(
          `  proc ${p.name}: ${p.running ? statusColor("running") : pc.dim("stopped")}${tags ? ` (${tags})` : ""}`,
        );
      }
      for (const u of state.urls) line(`  ${u.name}: ${pc.cyan(u.url)}`);
    });

  program
    .command("logs <id> <process>")
    .description("Print a process's logs")
    .option("-f, --follow", "stream new output until Ctrl-C")
    .action(
      async (id: string, process_: string, opts: { follow?: boolean }) => {
        const api = ctx.api();
        if (opts.follow) {
          const controller = new AbortController();
          process.once("SIGINT", () => controller.abort());
          await followLogs(api, id, process_, {
            signal: controller.signal,
            onChunk: (chunk) => process.stdout.write(chunk),
          });
          return;
        }
        const { content } = unwrap(
          await api.v1
            .sandboxes({ id })
            .processes({ name: process_ })
            .logs.get(),
        );
        process.stdout.write(content);
        if (content && !content.endsWith("\n")) process.stdout.write("\n");
      },
    );

  program
    .command("exec <id>")
    .description("Run a command in a sandbox (use -- to pass flags)")
    .option("--cwd <dir>", "working directory")
    .option("--user <user>", "run as dev|root (default dev)")
    .argument("[command...]", "command to run")
    .action(
      async (
        id: string,
        cmd: string[],
        opts: { cwd?: string; user?: string },
      ) => {
        const command = cmd.join(" ").trim();
        if (!command) fail("exec needs a command");
        const result = unwrap(
          await ctx
            .api()
            .v1.sandboxes({ id })
            .exec.post({
              command,
              ...(opts.cwd ? { cwd: opts.cwd } : {}),
              ...(opts.user === "root" || opts.user === "dev"
                ? { user: opts.user }
                : {}),
            }),
        );
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      },
    );

  program
    .command("pause <id>")
    .description("Pause a running sandbox")
    .action(async (id: string) => {
      await ctx.api().v1.sandboxes({ id }).pause.post().then(unwrap);
      line(`paused ${id}`);
    });

  program
    .command("resume <id>")
    .description("Resume a paused sandbox")
    .option("--env <pair>", "KEY=VALUE to inject (repeatable)", collect, [])
    .action(async (id: string, opts: { env: string[] }) => {
      const env = parseEnvPairs(opts.env);
      const req: ResumeRequest = Object.keys(env).length > 0 ? { env } : {};
      const state = unwrap(
        await ctx.api().v1.sandboxes({ id }).resume.post(req),
      );
      if (ctx.json) return printJson(state);
      line(`resumed ${state.id}  [${statusColor(state.status)}]`);
    });

  program
    .command("rm <id>")
    .description("Destroy a sandbox")
    .action(async (id: string) => {
      await ctx.api().v1.sandboxes({ id }).delete().then(unwrap);
      line(`removed ${id}`);
    });

  program
    .command("attach <id> [process]")
    .description(
      "Attach to a process over the stdio/PTY bridge (Ctrl-] detaches)",
    )
    .action(async (id: string, process_?: string) => {
      await attach(ctx.config(), id, process_ ?? "acp");
    });

  program
    .command("ssh <id>")
    .description("SSH into a sandbox (or print the command with --print)")
    .option("--print", "print the ssh command instead of running it")
    .action(async (id: string, opts: { print?: boolean }) => {
      const state = unwrap(await ctx.api().v1.sandboxes({ id }).get());
      const cmd = sshCommand(state.urls);
      if (!cmd) fail(`sandbox ${id} exposes no ssh endpoint`);
      if (opts.print || ctx.json) {
        if (ctx.json) return printJson({ command: cmd.join(" ") });
        return line(cmd.join(" "));
      }
      process.exit(await runInherit(cmd));
    });

  program
    .command("sync <local> <remote>")
    .description("Upload a file/dir to <id>:<remotePath>")
    .action(async (local: string, remote: string) => {
      const { id, path } = splitRemote(remote);
      const files = collectFiles(local, path);
      if (files.length === 0) fail(`no files under ${local}`);
      await ctx.api().v1.sandboxes({ id }).files.patch(files).then(unwrap);
      line(`synced ${files.length} file(s) to ${id}:${path}`);
    });

  program
    .command("env <id> [pairs...]")
    .description("Patch live env vars (KEY=VALUE ...)")
    .action(async (id: string, pairs: string[]) => {
      if (pairs.length === 0) fail("env needs at least one KEY=VALUE");
      const env = parseEnvPairs(pairs);
      await ctx.api().v1.sandboxes({ id }).env.patch(env).then(unwrap);
      line(`patched ${Object.keys(env).length} env var(s) on ${id}`);
    });

  program
    .command("expose <id> <name> <port>")
    .description("Expose a port under a name")
    .option("--no-public", "keep the port private")
    .action(
      async (
        id: string,
        name: string,
        port: string,
        opts: { public: boolean },
      ) => {
        const p = Number(port);
        if (!Number.isFinite(p)) fail("expose needs a numeric port");
        await ctx
          .api()
          .v1.sandboxes({ id })
          .ports.post({ name, port: p, public: opts.public })
          .then(unwrap);
        line(`exposed ${name} (:${p}) on ${id}`);
      },
    );

  program
    .command("snapshot <id>")
    .description("Snapshot a sandbox's volume")
    .action(async (id: string) => {
      const ref = unwrap(await ctx.api().v1.sandboxes({ id }).snapshot.post());
      if (ctx.json) return printJson(ref);
      line(`${ref.ref}\t${ref.hash}`);
    });

  registerProcess(program, ctx);
}

function registerProcess(program: Command, ctx: Ctx): void {
  const process_ = program
    .command("process")
    .description("Manage supervised processes in a sandbox");

  process_
    .command("start <id> <name>")
    .description("Start a process")
    .action(async (id: string, name: string) => {
      await ctx
        .api()
        .v1.sandboxes({ id })
        .processes({ name })({ action: "start" })
        .post()
        .then(unwrap);
      line(`started ${name} on ${id}`);
    });

  process_
    .command("stop <id> <name>")
    .description("Stop a process")
    .action(async (id: string, name: string) => {
      await ctx
        .api()
        .v1.sandboxes({ id })
        .processes({ name })({ action: "stop" })
        .post()
        .then(unwrap);
      line(`stopped ${name} on ${id}`);
    });

  process_
    .command("add <id>")
    .description("Register a new process (from --spec or flags)")
    .option("--spec <file>", "process spec (JSONC)")
    .option("--name <name>", "process name")
    .option("--command <cmd>", "command line")
    .option("--cwd <dir>", "working directory")
    .option("--user <user>", "run as user")
    .option("--primary", "mark as the primary process")
    .option("--pty", "allocate a PTY")
    .action(
      async (
        id: string,
        opts: {
          spec?: string;
          name?: string;
          command?: string;
          cwd?: string;
          user?: string;
          primary?: boolean;
          pty?: boolean;
        },
      ) => {
        let proc: AddProcessRequest;
        if (opts.spec) {
          proc = readJsonc<AddProcessRequest>(opts.spec);
        } else {
          const name = opts.name ?? fail("process add needs --name or --spec");
          const command =
            opts.command ?? fail("process add needs --command or --spec");
          proc = {
            name,
            command,
            ...(opts.cwd ? { cwd: opts.cwd } : {}),
            ...(opts.user ? { user: opts.user } : {}),
            ...(opts.primary ? { primary: true } : {}),
            ...(opts.pty ? { pty: true } : {}),
          };
        }
        await ctx.api().v1.sandboxes({ id }).processes.post(proc).then(unwrap);
        line(`added process ${proc.name} on ${id}`);
      },
    );
}
