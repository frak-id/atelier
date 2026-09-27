/**
 * Small helpers shared by every module. Nothing here touches the DB schema.
 */
/** `mem_…`, `fact_…`, `aud_…`: prefixed, sortable-enough random ids. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const rand = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  return `${prefix}_${time}${rand}`;
}

/** Decodes a JSON column, falling back when NULL/empty/corrupt. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** `null` → `undefined`, for mapping nullable columns to optional fields. */
export function opt<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/** JSON with object keys sorted, so equal values hash equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

export function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}
