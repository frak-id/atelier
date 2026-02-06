import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AtelierConfigSchema } from "../src/config.schema.ts";

const outPath = resolve(
  import.meta.dirname,
  "../schemas/atelier.config.schema.json",
);

const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  ...AtelierConfigSchema,
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(schema, null, 2)}\n`);

console.log(`✓ JSON Schema written to ${outPath}`);
