#!/usr/bin/env bun
/**
 * Enforces the atelier-v2 §3.1 module boundaries at build time, not by
 * convention:
 *   - runtime/  must not import control/ or sessions/ (it compiles alone —
 *     the future extraction seam);
 *   - sessions/ must not import control/ (it talks to sandboxes only through
 *     the runtime API);
 *   - sessions/ may import runtime/'s interface, never its internals (same
 *     rule as control/ below — the barrel is the only stable surface);
 *   - control/  may import runtime/'s interface, never its internals;
 *   - integrations/ imports none of control/, sessions/, runtime/ (it gets
 *     everything through arguments wired in api/container.ts);
 *   - a vendor directory integrations/<id>/ imports only ../integration.ts
 *     (plus shared/ and the workspace packages), and only
 *     integrations/catalog.ts imports a vendor directory.
 */
import { Glob } from "bun";

interface Rule {
  module: string;
  forbidden: RegExp[];
  reason: string;
}

const RULES: Rule[] = [
  {
    module: "runtime",
    forbidden: [
      /from\s+["'](?:\.\.\/)+control\//,
      /from\s+["'](?:\.\.\/)+sessions\//,
    ],
    reason: "runtime/ must compile without control/ or sessions/",
  },
  {
    module: "sessions",
    forbidden: [
      /from\s+["'](?:\.\.\/)+control\//,
      /from\s+["'](?:\.\.\/)+runtime\/[^"']+\/[^"']/,
    ],
    reason:
      "sessions/ talks to sandboxes only through the runtime API — import " +
      "runtime/'s barrel (../runtime/index.ts), not its internals",
  },
  {
    module: "control",
    forbidden: [/from\s+["'](?:\.\.\/)+runtime\/[^"']+\/[^"']/],
    reason:
      "control/ imports runtime/'s interface (index), never its internals",
  },
  {
    module: "integrations",
    forbidden: [/from\s+["'](?:\.\.\/)+(?:control|sessions|runtime)\//],
    reason:
      "integrations/ gets control/sessions/runtime only through arguments " +
      "wired in api/container.ts",
  },
];

/** A vendor directory: `integrations/<id>/…`. */
const VENDOR_FILE = /^integrations\/[^/]+\//;

/** Only `integrations/catalog.ts` names a vendor directory; a vendor file
 * reaches its siblings only through `../integration.ts`. Checked over the
 * whole tree, so it is a pass of its own. */
function vendorViolations(rel: string, text: string): string | undefined {
  if (VENDOR_FILE.test(rel)) {
    return /from\s+["']\.\.\/(?!integration\.ts["'])(?!\.\.\/)[^"']+["']/.test(
      text,
    )
      ? "a vendor integration imports only ../integration.ts among " +
          "integrations/ files"
      : undefined;
  }
  if (rel === "integrations/catalog.ts") return undefined;
  const vendorImport = rel.startsWith("integrations/")
    ? /from\s+["']\.\/[^"']+\//
    : /from\s+["'][^"']*\bintegrations\/[^"'/]+\//;
  return vendorImport.test(text)
    ? "only integrations/catalog.ts imports a vendor integration"
    : undefined;
}

const root = new URL("../src", import.meta.url).pathname;
let violations = 0;

for (const rule of RULES) {
  const glob = new Glob(`${rule.module}/**/*.ts`);
  for await (const rel of glob.scan(root)) {
    const path = `${root}/${rel}`;
    const text = await Bun.file(path).text();
    for (const pattern of rule.forbidden) {
      if (pattern.test(text)) {
        console.error(`✗ ${rule.module}/${rel}: ${rule.reason}`);
        violations++;
      }
    }
  }
}

for await (const rel of new Glob("**/*.ts").scan(root)) {
  const text = await Bun.file(`${root}/${rel}`).text();
  const reason = vendorViolations(rel, text);
  if (reason) {
    console.error(`✗ ${rel}: ${reason}`);
    violations++;
  }
}

if (violations > 0) {
  console.error(`\n${violations} boundary violation(s).`);
  process.exit(1);
}
console.log("✓ module boundaries clean");
