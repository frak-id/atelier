import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const sourcePath = join(here, "src", "plugin.ts");
const outPath = join(here, "src", "plugin.embedded.ts");

const raw = readFileSync(sourcePath, "utf-8");

const banner = [
  "// AUTO-GENERATED from ./plugin.ts by ../../build.ts.",
  "// DO NOT EDIT BY HAND. Run `bun run build` after editing plugin.ts.",
  "",
].join("\n");

const body = [
  "export const PLUGIN_SOURCE: string =",
  `  ${JSON.stringify(raw)};`,
  "",
  "export const PLUGIN_VM_PATH =",
  '  "~/.config/opencode/plugins/atelier-preregister.ts";',
  "",
].join("\n");

writeFileSync(outPath, banner + body);
console.log(
  `[atelier-server] embedded ${raw.length} chars of plugin source into ${outPath}`,
);
