#!/usr/bin/env bun
/**
 * `atelier` — the CLI reference client for the `/v1` runtime API (atelier-v2
 * §4). Thin: parse args, call {@link AtelierClient}, print. Composition of
 * specs is the caller's job (a spec file, or `@atelier/compose` presets).
 *
 * Lifecycle commands (this build): up, ps, get, logs, exec, pause, resume, rm.
 * WS/local-diff commands (attach, sync, expose, snapshot, prebuild, --bake)
 * land next.
 */
import { readFileSync } from "node:fs";
import type { ResumeRequest, SandboxSpec } from "@atelier/spec";
import { ApiError, AtelierClient } from "./client.ts";
import { resolveConfig } from "./config.ts";

const USAGE = `atelier — client for the atelier /v1 API

Usage:
  atelier up (--spec <file> | --from-snapshot <ref> | --image <ref>)
             [--vcpus <n>] [--memory <mb>] [--json]
  atelier ps [--json]
  atelier get <id> [--json]
  atelier logs <id> <process>
  atelier exec <id> [--cwd <dir>] -- <command...>
  atelier pause <id>
  atelier resume <id> [--env KEY=VALUE ...]
  atelier rm <id>

Env:
  ATELIER_API_URL   server base URL (default http://localhost:4000)
  ATELIER_API_KEY   Bearer key (atl_… from POST /api-keys)`;

function fail(message: string): never {
  process.stderr.write(`atelier: ${message}\n`);
  process.exit(1);
}

/** Minimal JSONC: strips `//` and block comments (string-aware), then
 * JSON.parse. Trailing commas are not supported (a naive strip risks
 * corrupting string values that contain `,}`); keep spec files valid-JSON
 * apart from comments. */
function parseJsonc(text: string): unknown {
  let out = "";
  let inStr = false;
  let quote = "";
  let line = false;
  let block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (line) {
      if (c === "\n") {
        line = false;
        out += c;
      }
    } else if (block) {
      if (c === "*" && n === "/") {
        block = false;
        i++;
      }
    } else if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i++;
      } else if (c === quote) {
        inStr = false;
      }
    } else if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
    } else if (c === "/" && n === "/") {
      line = true;
      i++;
    } else if (c === "/" && n === "*") {
      block = true;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out);
}

/** Split argv into positionals + a flag map (`--k v`, `--k=v`, repeatable). */
function parseArgs(argv: string[]): {
  positionals: string[];
  flags: Map<string, string[]>;
} {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    // `--` sentinel: everything after is a positional verbatim (so
    // `exec <id> -- cmd --with-flags` passes the flags through untouched).
    if (a === "--") {
      for (let j = i + 1; j < argv.length; j++) {
        const rest = argv[j];
        if (rest !== undefined) positionals.push(rest);
      }
      break;
    }
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    let key: string;
    let value: string;
    if (eq !== -1) {
      key = a.slice(2, eq);
      value = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = "true";
      }
    }
    const existing = flags.get(key);
    if (existing) existing.push(value);
    else flags.set(key, [value]);
  }
  return { positionals, flags };
}

const one = (flags: Map<string, string[]>, key: string): string | undefined =>
  flags.get(key)?.at(-1);

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function buildUpSpec(flags: Map<string, string[]>): SandboxSpec {
  const specFile = one(flags, "spec");
  if (specFile) {
    const parsed = parseJsonc(readFileSync(specFile, "utf8")) as SandboxSpec;
    return parsed;
  }
  const snapshot = one(flags, "from-snapshot");
  const image = one(flags, "image");
  if (!snapshot && !image) {
    fail("up needs --spec <file>, --from-snapshot <ref>, or --image <ref>");
  }
  const vcpus = Number(one(flags, "vcpus") ?? "2");
  const memoryMb = Number(one(flags, "memory") ?? "2048");
  if (!Number.isFinite(vcpus) || !Number.isFinite(memoryMb)) {
    fail("--vcpus and --memory must be numbers");
  }
  return {
    source: snapshot ? { snapshot } : { image: image as string },
    resources: { vcpus, memoryMb },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const { positionals, flags } = parseArgs(argv.slice(1));
  const json = flags.has("json");
  const client = new AtelierClient(resolveConfig());

  switch (command) {
    case "up": {
      const result = await client.create(buildUpSpec(flags));
      if (json) return print(result);
      process.stdout.write(`${result.id}\n`);
      for (const u of result.urls)
        process.stdout.write(`  ${u.name}: ${u.url}\n`);
      return;
    }
    case "ps": {
      const rows = await client.list();
      if (json) return print(rows);
      if (rows.length === 0) {
        process.stdout.write("no sandboxes\n");
        return;
      }
      for (const r of rows) {
        const harness = r.annotations?.["atelier.dev/harness"] ?? "-";
        process.stdout.write(
          `${r.id}\t${r.status}\t${harness}\t${r.createdAt}\n`,
        );
      }
      return;
    }
    case "get": {
      const id = positionals[0] ?? fail("get needs a sandbox id");
      const state = await client.get(id);
      if (json) return print(state);
      process.stdout.write(`${state.id}  [${state.status}]\n`);
      for (const p of state.processes) {
        const flagsStr = [p.primary ? "primary" : "", p.ready ? "ready" : ""]
          .filter(Boolean)
          .join(",");
        process.stdout.write(
          `  proc ${p.name}: ${p.running ? "running" : "stopped"}${flagsStr ? ` (${flagsStr})` : ""}\n`,
        );
      }
      for (const u of state.urls)
        process.stdout.write(`  ${u.name}: ${u.url}\n`);
      return;
    }
    case "logs": {
      const id = positionals[0] ?? fail("logs needs a sandbox id");
      const proc = positionals[1] ?? fail("logs needs a process name");
      const { content } = await client.logs(id, proc);
      process.stdout.write(content);
      if (content && !content.endsWith("\n")) process.stdout.write("\n");
      return;
    }
    case "exec": {
      const id = positionals[0] ?? fail("exec needs a sandbox id");
      const cmd = positionals.slice(1).join(" ").trim();
      if (!cmd) fail("exec needs a command");
      const result = await client.exec(id, {
        command: cmd,
        cwd: one(flags, "cwd"),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
      return;
    }
    case "pause": {
      const id = positionals[0] ?? fail("pause needs a sandbox id");
      await client.pause(id);
      process.stdout.write(`paused ${id}\n`);
      return;
    }
    case "resume": {
      const id = positionals[0] ?? fail("resume needs a sandbox id");
      const envPairs = flags.get("env") ?? [];
      const env: Record<string, string> = {};
      for (const pair of envPairs) {
        const eq = pair.indexOf("=");
        if (eq === -1) fail(`--env expects KEY=VALUE, got "${pair}"`);
        env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      const req: ResumeRequest = Object.keys(env).length > 0 ? { env } : {};
      const state = await client.resume(id, req);
      if (json) return print(state);
      process.stdout.write(`resumed ${state.id}  [${state.status}]\n`);
      return;
    }
    case "rm": {
      const id = positionals[0] ?? fail("rm needs a sandbox id");
      await client.destroy(id);
      process.stdout.write(`removed ${id}\n`);
      return;
    }
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main().catch((err) => {
  if (err instanceof ApiError) fail(`${err.message} (HTTP ${err.status})`);
  fail(err instanceof Error ? err.message : String(err));
});
