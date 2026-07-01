#!/usr/bin/env bun
/**
 * Enforces the atelier-v2 §3.1 module boundaries at build time, not by
 * convention:
 *   - runtime/  must not import control/ or sessions/ (it compiles alone —
 *     the future extraction seam);
 *   - sessions/ must not import control/ (it talks to sandboxes only through
 *     the runtime API);
 *   - control/  may import runtime/'s interface, never its internals.
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
    forbidden: [/from\s+["']\.\.\/control\//, /from\s+["']\.\.\/sessions\//],
    reason: "runtime/ must compile without control/ or sessions/",
  },
  {
    module: "sessions",
    forbidden: [/from\s+["']\.\.\/control\//],
    reason: "sessions/ talks to sandboxes only through the runtime API",
  },
  {
    module: "control",
    forbidden: [/from\s+["']\.\.\/runtime\/[^"']+\/[^"']/],
    reason:
      "control/ imports runtime/'s interface (index), never its internals",
  },
];

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

if (violations > 0) {
  console.error(`\n${violations} boundary violation(s).`);
  process.exit(1);
}
console.log("✓ module boundaries clean");
