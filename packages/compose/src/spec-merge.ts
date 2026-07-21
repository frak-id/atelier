/**
 * Client-side spec merge (atelier-v2 §3: "the spec-file merge … defined once
 * here, not an open question: deep-merge, arrays merged by `name`/`path`,
 * last layer wins").
 *
 * A fragment is a `Partial<SandboxSpec>`: what a preset, a harness composer,
 * or a repo's `atelier.jsonc` contributes. `mergeSpecs` folds any number of
 * fragments, left to right, into one fragment. The caller (CLI/console/MCP)
 * is responsible for validating the final result is a complete `SandboxSpec`
 * (has `source` + `resources`) before calling the runtime API.
 */
import type { SandboxSpec } from "@atelier/spec";

export type SpecFragment = Partial<SandboxSpec>;

/** Array fields merged by an identity key instead of concatenation. */
const KEYED_ARRAY_FIELDS = {
  files: "path",
  processes: "name",
  ports: "name",
  caches: "name",
} as const satisfies Record<string, string>;

type KeyedArrayField = keyof typeof KEYED_ARRAY_FIELDS;

/** Object fields deep-merged key by key instead of replaced wholesale. */
const OBJECT_FIELDS = ["env", "metadata", "annotations"] as const;
type ObjectField = (typeof OBJECT_FIELDS)[number];

/** `hooks.*` arrays concatenate, in fragment order, rather than replace. */
const HOOK_ARRAY_FIELDS = [
  "postCreate",
  "postStart",
  "onResume",
  "envChanged",
] as const;

function isKeyedArrayField(key: string): key is KeyedArrayField {
  return Object.hasOwn(KEYED_ARRAY_FIELDS, key);
}

function isObjectField(key: string): key is ObjectField {
  return (OBJECT_FIELDS as readonly string[]).includes(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge an array field by identity key: entries from `next` overwrite
 * entries in `acc` that share the same key value; new entries are appended
 * in the order they first appear. Order of pre-existing entries is
 * preserved (last-fragment-wins on content, not on position).
 */
function mergeKeyedArray(
  acc: unknown[],
  next: unknown[],
  key: string,
): unknown[] {
  const merged = [...acc];
  const indexByKey = new Map<unknown, number>();
  for (const [i, entry] of merged.entries()) {
    if (isRecord(entry)) indexByKey.set(entry[key], i);
  }

  for (const entry of next) {
    if (!isRecord(entry)) {
      merged.push(entry);
      continue;
    }
    const existingIndex = indexByKey.get(entry[key]);
    if (existingIndex === undefined) {
      indexByKey.set(entry[key], merged.length);
      merged.push(entry);
    } else {
      merged[existingIndex] = entry;
    }
  }

  return merged;
}

/** Shallow-merge two `Record<string, unknown>` maps, `next` winning. */
function mergeObjectField(
  acc: unknown,
  next: unknown,
): Record<string, unknown> {
  const base = isRecord(acc) ? acc : {};
  const incoming = isRecord(next) ? next : {};
  return { ...base, ...incoming };
}

/** Merge `hooks` fragments: each phase array concatenates in fragment order. */
function mergeHooks(acc: unknown, next: unknown): Record<string, unknown> {
  const base = isRecord(acc) ? acc : {};
  const incoming = isRecord(next) ? next : {};
  const merged: Record<string, unknown> = { ...base };

  for (const field of HOOK_ARRAY_FIELDS) {
    const baseArr = Array.isArray(base[field])
      ? (base[field] as unknown[])
      : [];
    const nextArr = Array.isArray(incoming[field])
      ? (incoming[field] as unknown[])
      : [];
    if (baseArr.length > 0 || nextArr.length > 0) {
      merged[field] = [...baseArr, ...nextArr];
    }
  }

  // Any non-standard key on a hooks fragment (forward-compat) just overwrites.
  for (const [k, v] of Object.entries(incoming)) {
    if (!(HOOK_ARRAY_FIELDS as readonly string[]).includes(k)) merged[k] = v;
  }

  return merged;
}

function mergeTwo(acc: SpecFragment, next: SpecFragment): SpecFragment {
  const result: Record<string, unknown> = { ...acc };

  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;

    if (key === "hooks") {
      result.hooks = mergeHooks(result.hooks, value);
      continue;
    }

    if (isObjectField(key)) {
      result[key] = mergeObjectField(result[key], value);
      continue;
    }

    if (isKeyedArrayField(key) && Array.isArray(value)) {
      const existing = Array.isArray(result[key])
        ? (result[key] as unknown[])
        : [];
      result[key] = mergeKeyedArray(existing, value, KEYED_ARRAY_FIELDS[key]);
      continue;
    }

    // Scalars (source, resources, timeoutSeconds) and anything else: last
    // fragment wins, replacing the whole value.
    result[key] = value;
  }

  return result as SpecFragment;
}

/**
 * Fold any number of spec fragments into one, left to right. Later
 * fragments win on scalar/object-key conflicts; keyed arrays (files by
 * `path`, processes/ports/caches by `name`) merge by identity; `hooks.*`
 * arrays concatenate in order.
 */
export function mergeSpecs(...fragments: SpecFragment[]): SpecFragment {
  return fragments.reduce(mergeTwo, {});
}
