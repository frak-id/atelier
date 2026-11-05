#!/usr/bin/env bun
import { dirname, relative, resolve } from "node:path";
/**
 * Enforces the server module boundaries at build time, not by convention.
 * Every import form is checked — static `import`, side-effect `import "x"`,
 * `export ... from "x"` and dynamic `import("x")` — after resolving the
 * specifier against the importing file, so `../../control/x.ts` is caught from
 * any depth.
 *
 *   - runtime/   compiles alone (the future extraction seam): no control/,
 *                sessions/, api/, ssh/, harnesses/;
 *   - sessions/  talks to sandboxes only through runtime's barrel: no
 *                control/, api/, ssh/, no runtime internals;
 *   - control/   same: no api/, sessions/, ssh/, no runtime internals;
 *   - harnesses/ pure harness definitions + spec merge: imports no other
 *                server module;
 *   - config/    the config schema/loader/constants: imports no other module;
 *   - shared/    cross-cutting helpers: may only reach config/ (this is what
 *                keeps runtime-config from reaching into control/);
 *   - api/app/   the application layer under HTTP + MCP: no routes, no MCP
 *                tools, no elysia.
 */
import { Glob } from "bun";

interface Rule {
  /** Importing files, relative to src (e.g. "runtime/", "api/app/"). */
  from: string;
  /** Resolved targets (relative to src) or bare package names that are
   * forbidden. */
  forbidden: RegExp[];
  reason: string;
}

const SIBLINGS = ["runtime", "control", "sessions", "api", "ssh", "harnesses"];
const dir = (...names: string[]) => new RegExp(`^(?:${names.join("|")})/`);
/** A file nested inside a runtime sub-folder: runtime/<dir>/<file>. */
const RUNTIME_INTERNALS = /^runtime\/[^/]+\/[^/]+/;

const RULES: Rule[] = [
  {
    from: "runtime/",
    forbidden: [dir("control", "sessions", "api", "ssh", "harnesses")],
    reason: "runtime/ must compile without the other server modules",
  },
  {
    from: "sessions/",
    forbidden: [dir("control", "api", "ssh"), RUNTIME_INTERNALS],
    reason:
      "sessions/ talks to sandboxes only through the runtime API — import " +
      "runtime/'s barrel (../runtime/index.ts), not its internals, and " +
      "never control/",
  },
  {
    from: "control/",
    forbidden: [dir("api", "sessions", "ssh"), RUNTIME_INTERNALS],
    reason:
      "control/ imports runtime/'s interface (index), never its internals, " +
      "and nothing above it",
  },
  {
    from: "harnesses/",
    forbidden: [
      dir("runtime", "control", "sessions", "api", "ssh", "config", "shared"),
    ],
    reason: "harnesses/ is a leaf: it imports no other server module",
  },
  {
    from: "config/",
    forbidden: [dir(...SIBLINGS, "shared")],
    reason: "config/ is a leaf: it imports no other server module",
  },
  {
    from: "shared/",
    forbidden: [dir(...SIBLINGS)],
    reason:
      "shared/ may only reach config/ — inject anything else (e.g. " +
      "bindRuntimeConfig) instead of importing a module",
  },
  {
    from: "api/app/",
    forbidden: [
      /^api\/mcp\//,
      /^api\/[^/]+\.routes\.ts$/,
      /^api\/auth\.plugin\.ts$/,
      /^api\/index\.ts$/,
      /^elysia$/,
      /^@elysiajs\//,
      /^@modelcontextprotocol\//,
    ],
    reason: "api/app/ is the application layer: no routes, MCP or elysia",
  },
];

const root = new URL("../src", import.meta.url).pathname;

/** Strip comments so a quoted import in prose is not flagged. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every module specifier: `from "x"` (import + export-from), `import "x"`
 * and `import("x")`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"'\n]+)["']/g;

function* specifiers(text: string): Generator<string> {
  for (const match of stripComments(text).matchAll(SPECIFIER)) {
    yield match[1] as string;
  }
}

/** The import target as a src-relative path, or the bare package name. */
function resolveTarget(file: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  return relative(root, resolve(dirname(`${root}/${file}`), specifier));
}

let violations = 0;

for await (const file of new Glob("**/*.ts").scan(root)) {
  const rules = RULES.filter((rule) => file.startsWith(rule.from));
  if (rules.length === 0) continue;
  const text = await Bun.file(`${root}/${file}`).text();
  for (const specifier of specifiers(text)) {
    const target = resolveTarget(file, specifier);
    for (const rule of rules) {
      if (rule.forbidden.some((pattern) => pattern.test(target))) {
        console.error(`✗ ${file} → ${specifier}: ${rule.reason}`);
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(`\n${violations} boundary violation(s).`);
  process.exit(1);
}
console.log("✓ module boundaries clean");
