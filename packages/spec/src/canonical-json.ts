/**
 * JSON with object keys sorted at every level: two values that differ only
 * in key order (a storage round-trip, a spread in an editor) serialize the
 * same. Array order is kept (it's meaningful). The spec-equality primitive.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}
