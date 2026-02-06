import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AtelierConfigSchema } from "../src/config.schema.ts";

type JsonSchema = Record<string, unknown>;

function makeDefaultedFieldsOptional(node: JsonSchema): JsonSchema {
  if (typeof node !== "object" || node === null) return node;

  const result = { ...node };

  if (result.properties && Array.isArray(result.required)) {
    const props = result.properties as Record<string, JsonSchema>;
    result.required = (result.required as string[]).filter(
      (key) => !("default" in (props[key] ?? {})),
    );
    if ((result.required as string[]).length === 0) {
      delete result.required;
    }
  }

  if (result.properties) {
    const props = result.properties as Record<string, JsonSchema>;
    result.properties = Object.fromEntries(
      Object.entries(props).map(([k, v]) => [
        k,
        makeDefaultedFieldsOptional(v),
      ]),
    );
  }

  if (result.items && typeof result.items === "object") {
    result.items = makeDefaultedFieldsOptional(result.items as JsonSchema);
  }

  if (Array.isArray(result.anyOf)) {
    result.anyOf = (result.anyOf as JsonSchema[]).map(
      makeDefaultedFieldsOptional,
    );
  }

  return result;
}

function buildFullExample(node: JsonSchema): unknown {
  if (node.type === "object" && node.properties) {
    const props = node.properties as Record<string, JsonSchema>;
    return Object.fromEntries(
      Object.entries(props).map(([k, v]) => [k, buildFullExample(v)]),
    );
  }

  if (node.type === "array") {
    if ("default" in node) return node.default;
    return [];
  }

  if (Array.isArray(node.anyOf)) {
    const first = node.anyOf[0] as JsonSchema;
    return first?.const ?? first?.default ?? null;
  }

  if ("default" in node) return node.default;
  if (node.type === "string") return "";
  if (node.type === "number") return 0;
  if (node.type === "boolean") return false;

  return null;
}

const outDir = resolve(import.meta.dirname, "../schemas");
await mkdir(outDir, { recursive: true });

const schema = makeDefaultedFieldsOptional({
  $schema: "http://json-schema.org/draft-07/schema#",
  ...AtelierConfigSchema,
});

const schemaPath = resolve(outDir, "atelier.config.schema.json");
await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`✓ JSON Schema written to ${schemaPath}`);

const example = buildFullExample(schema);
const examplePath = resolve(outDir, "sandbox.config.full-example.json");
await writeFile(examplePath, `${JSON.stringify(example, null, 2)}\n`);
console.log(`✓ Full example written to ${examplePath}`);
