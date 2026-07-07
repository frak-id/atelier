/**
 * Control-side "recipe fingerprint" — a display/drift hash over exactly the
 * inputs that determine a toolbox's built deliverable, used to badge "recipe
 * changed since pin" (docs/toolbox-versions.md §3). Deliberately independent
 * of runtime's `hashToolset`: that one also keys on `name` (the registry
 * repo) and is a cache key, not a display concern; this one only needs to
 * answer "did the toolbox's recipe move since this version was saved".
 */
import { createHash } from "node:crypto";
import type { Source } from "@atelier/spec";

export function recipeFingerprint(config: {
  source?: Source;
  build: string[];
  paths: string[];
}): string {
  const keyed = {
    source: config.source ?? null,
    build: config.build,
    paths: config.paths,
  };
  return createHash("sha256").update(JSON.stringify(keyed)).digest("hex");
}
