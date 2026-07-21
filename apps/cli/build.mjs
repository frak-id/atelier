#!/usr/bin/env node
/**
 * Bundles the CLI into a single ESM file for npm publication. The CLI is
 * engine-generic and runs on any modern Node (>=20) — its runtime deps
 * (commander, picocolors, @clack/prompts, @elysiajs/eden, ws) stay external
 * and the type-only `@atelier/*` workspace imports are erased by the bundler.
 * Run the published artifact with `npx @konfeature/atelier`.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const outfile = "dist/index.js";

await build({
  entryPoints: ["src/index.ts"],
  platform: "node",
  format: "esm",
  target: "node20",
  bundle: true,
  minify: true,
  external: ["commander", "picocolors", "@clack/prompts", "@elysiajs/eden", "ws"],
  outfile,
});

// esbuild preserves the entry's shebang; normalize it to node.
const original = readFileSync(outfile, "utf8").replace(/^#!.*\n/, "");
const patched = `#!/usr/bin/env node\n${original}`;
writeFileSync(outfile, patched);
chmodSync(outfile, 0o755);

console.log(`Built ${outfile} (${(patched.length / 1024).toFixed(1)} KB)`);
