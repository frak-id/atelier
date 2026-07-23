/** Small pure helpers shared across commands. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join as joinPath, relative as relPath } from "node:path";
import type { PatchFilesRequest } from "@atelier/spec";
import { fail } from "./output.ts";
import { spawnDetached } from "./proc.ts";

/** Minimal JSONC: strips `//` and block comments (string-aware), then
 * JSON.parse. Trailing commas are not supported — keep spec files valid JSON
 * apart from comments. */
export function parseJsonc(text: string): unknown {
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

export function readJsonc<T>(file: string): T {
  return parseJsonc(readFileSync(file, "utf8")) as T;
}

/** Build a PatchFiles payload from a local file or directory tree, mapping
 * each file under `remoteBase` (preserving the tree for a directory). */
export function collectFiles(
  local: string,
  remoteBase: string,
): PatchFilesRequest {
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

/** Split `id:/remote/path` into its parts (only the first colon splits). */
export function splitRemote(arg: string): { id: string; path: string } {
  const colon = arg.indexOf(":");
  if (colon === -1) fail(`expected <id>:<remotePath>, got "${arg}"`);
  return { id: arg.slice(0, colon), path: arg.slice(colon + 1) };
}

/** Open a URL in the platform's default browser (best-effort, non-blocking). */
export function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  spawnDetached(cmd);
}

/** Commander accumulator for repeatable options: `.option("--x", d, collect, [])`. */
export const collect = (v: string, acc: string[]): string[] => {
  acc.push(v);
  return acc;
};

/** Parse repeatable `KEY=VALUE` pairs into a record. */
export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) fail(`expected KEY=VALUE, got "${pair}"`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}
