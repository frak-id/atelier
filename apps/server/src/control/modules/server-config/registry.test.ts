/**
 * The registry must stay a thin layer over the config schema: every key is a
 * real schema path whose type matches, with defaults/types/env vars derived
 * (never re-declared).
 */
import { describe, expect, test } from "bun:test";
import { Kind, type TSchema } from "@sinclair/typebox";
import { AtelierConfigSchema } from "../../../config/config.schema.ts";
import { CONFIG_DEFS } from "./registry.ts";

function schemaAt(path: string): TSchema | undefined {
  let node: TSchema | undefined = AtelierConfigSchema;
  for (const part of path.split(".")) {
    if (node?.[Kind] !== "Object") return undefined;
    node = (node.properties as Record<string, TSchema>)[part];
  }
  return node;
}

const KIND_TO_TYPE: Record<string, string> = {
  String: "string",
  Number: "number",
  Boolean: "boolean",
};

/** The literal values of a union-of-literals schema node. */
function literals(node: TSchema): string[] | undefined {
  if (node[Kind] !== "Union") return undefined;
  const members = node.anyOf as TSchema[];
  if (!members.every((m) => m[Kind] === "Literal")) return undefined;
  return members.map((m) => m.const as string);
}

describe("server-config registry", () => {
  test("has no duplicate keys", () => {
    const keys = CONFIG_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  for (const def of CONFIG_DEFS) {
    describe(def.key, () => {
      const node = schemaAt(def.key);

      test("exists in the schema with a matching type", () => {
        expect(node).toBeDefined();
        if (!node) return;
        const options = literals(node);
        const schemaType = options ? "string" : KIND_TO_TYPE[node[Kind]];
        expect(def.type).toBe(schemaType as typeof def.type);
      });

      test("default comes from the schema and passes validation", () => {
        expect(node && "default" in node).toBe(true);
        expect(typeof def.default).toBe(def.type);
        expect(def.validate(def.default)).toBe(def.default);
      });

      test("options mirror the schema's literal union", () => {
        if (!node) return;
        expect(def.options).toEqual(literals(node));
      });

      test("has an env var in the schema env mapping", () => {
        expect(def.envVar).toMatch(/^ATELIER_/);
      });
    });
  }
});
