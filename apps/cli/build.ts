#!/usr/bin/env bun
/**
 * Bundles the CLI into a single node-compatible ESM file for npm publication.
 * Runtime deps stay external (installed from the registry); the type-only
 * `@atelier/*` workspace imports are erased at build time. The bun shebang of
 * the source is rewritten to node so the published bin runs anywhere.
 */
import { chmodSync } from "node:fs";

const outfile = "dist/index.js";

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  target: "node",
  minify: true,
  external: ["commander", "picocolors", "@clack/prompts", "@elysiajs/eden"],
  outdir: "dist",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const original = await Bun.file(outfile).text();
const patched = original.replace(
  /^#!.*\n(\/\/ @bun\n)?/,
  "#!/usr/bin/env node\n",
);
await Bun.write(outfile, patched);
chmodSync(outfile, 0o755);

console.log(`Built ${outfile} (${(patched.length / 1024).toFixed(1)} KB)`);
