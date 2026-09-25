/**
 * Small helpers shared by every module. Nothing here touches the DB schema.
 */
import type { AccessResolver, Audience, Principal, Readers } from "./types.ts";
import { ORG_PRINCIPAL } from "./types.ts";

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

/** Exact match, plus `org` covering everyone. */
export const defaultAccessResolver: AccessResolver = {
  covers(reader: Principal, principal: Principal): boolean {
    return reader === ORG_PRINCIPAL || reader === principal;
  },
};

/**
 * A resolver from a static membership map (`team:platform` → members).
 * Good enough for a single-tenant hub whose teams come from config or a
 * directory sync; swap in a live directory lookup when that's needed.
 */
export function membershipResolver(
  members: Record<Principal, Principal[]>,
): AccessResolver {
  const index = new Map<Principal, Set<Principal>>();
  for (const [group, list] of Object.entries(members)) {
    index.set(group, new Set(list));
  }
  return {
    covers(reader, principal) {
      if (defaultAccessResolver.covers(reader, principal)) return true;
      return index.get(reader)?.has(principal) ?? false;
    },
  };
}

/**
 * The audience rule: every principal of the audience must be covered by at
 * least one reader. An empty audience sees nothing (fail closed); an empty
 * readers list is visible to no one.
 */
export function isVisible(
  readers: Readers,
  audience: Audience,
  resolver: AccessResolver = defaultAccessResolver,
): boolean {
  if (audience.length === 0 || readers.length === 0) return false;
  return audience.every((principal) =>
    readers.some((reader) => resolver.covers(reader, principal)),
  );
}

/** The narrower of two reader sets, for records derived from several. */
export function intersectReaders(a: Readers, b: Readers): Readers {
  if (a.includes(ORG_PRINCIPAL)) return [...b];
  if (b.includes(ORG_PRINCIPAL)) return [...a];
  return a.filter((r) => b.includes(r));
}
