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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join as joinPath, relative as relPath } from "node:path";
import type {
  PatchFilesRequest,
  PrebuildSpec,
  ResumeRequest,
  SandboxSpec,
} from "@atelier/spec";
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
  atelier attach <id> [process]           (default process: acp)
  atelier sync <localPath> <id>:<remotePath>
  atelier expose <id> <name> <port> [--no-public]
  atelier snapshot <id>
  atelier prebuild <file>

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

/** Build a PatchFiles payload from a local file or directory tree, mapping
 * each file under `remoteBase` (preserving the tree for a directory). Reads as
 * UTF-8 — `sync` targets text config (dotfiles), not binaries. */
function collectFiles(local: string, remoteBase: string): PatchFilesRequest {
  const st = statSync(local);
  const octalMode = (m: number): string => (m & 0o777).toString(8);
  if (st.isFile()) {
    return [
      {
        path: remoteBase,
        content: readFileSync(local, "utf8"),
        mode: octalMode(st.mode),
      },
    ];
  }
  const out: PatchFilesRequest = [];
  for (const entry of readdirSync(local, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const abs = joinPath(entry.parentPath, entry.name);
    const rel = relPath(local, abs);
    const fst = statSync(abs);
    out.push({
      path: `${remoteBase}/${rel}`,
      content: readFileSync(abs, "utf8"),
      mode: octalMode(fst.mode),
    });
  }
  return out;
}

/** Split `id:/remote/path` into its parts (the remote path may contain more
 * colons, so only the first splits). */
function splitRemote(arg: string): { id: string; path: string } {
  const colon = arg.indexOf(":");
  if (colon === -1) fail(`expected <id>:<remotePath>, got "${arg}"`);
  return { id: arg.slice(0, colon), path: arg.slice(colon + 1) };
}

/** Interactive attach: pipe local stdin<->the sandbox process over the WS
 * bridge. Ctrl-] detaches (like telnet). */
async function attach(
  client: AtelierClient,
  id: string,
  name: string,
): Promise<void> {
  const { url, headers } = client.wsAttach(id, name);
  // Bun's WebSocket accepts an options object with `headers` for the
  // handshake (non-DOM extension); the lib.dom type only allows protocols, so
  // declare Bun's actual signature locally rather than mistype the arg.
  const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  const ws = new BunWebSocket(url, { headers });
  ws.binaryType = "arraybuffer";
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  const restore = () => {
    if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
    stdin.pause();
  };

  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      // Ctrl-] (0x1d) detaches locally without killing the remote process.
      if (chunk.length === 1 && chunk[0] === 0x1d) {
        ws.close();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    };
    ws.onopen = () => {
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
    };
    ws.onmessage = (event) => {
      const d = event.data;
      if (d instanceof ArrayBuffer) process.stdout.write(Buffer.from(d));
      else process.stdout.write(String(d));
    };
    ws.onclose = () => {
      stdin.off("data", onData);
      restore();
      resolve();
    };
    ws.onerror = () => {
      stdin.off("data", onData);
      restore();
      reject(new Error(`attach failed: ${url}`));
    };
  });
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
    case "attach": {
      const id = positionals[0] ?? fail("attach needs a sandbox id");
      const name = positionals[1] ?? "acp";
      await attach(client, id, name);
      return;
    }
    case "sync": {
      const local = positionals[0] ?? fail("sync needs a local path");
      const remote = positionals[1] ?? fail("sync needs <id>:<remotePath>");
      const { id, path } = splitRemote(remote);
      const files = collectFiles(local, path);
      if (files.length === 0) fail(`no files under ${local}`);
      await client.patchFiles(id, files);
      process.stdout.write(`synced ${files.length} file(s) to ${id}:${path}\n`);
      return;
    }
    case "expose": {
      const id = positionals[0] ?? fail("expose needs a sandbox id");
      const name = positionals[1] ?? fail("expose needs a port name");
      const port = Number(positionals[2]);
      if (!Number.isFinite(port)) fail("expose needs a numeric port");
      await client.addPort(id, {
        name,
        port,
        public: !flags.has("no-public"),
      });
      process.stdout.write(`exposed ${name} (:${port}) on ${id}\n`);
      return;
    }
    case "snapshot": {
      const id = positionals[0] ?? fail("snapshot needs a sandbox id");
      const ref = await client.snapshot(id);
      if (json) return print(ref);
      process.stdout.write(`${ref.ref}\t${ref.hash}\n`);
      return;
    }
    case "prebuild": {
      const file = positionals[0] ?? fail("prebuild needs a spec file");
      const spec = parseJsonc(readFileSync(file, "utf8")) as PrebuildSpec;
      const ref = await client.prebuild(spec);
      if (json) return print(ref);
      process.stdout.write(`${ref.ref}\t${ref.hash}\n`);
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
