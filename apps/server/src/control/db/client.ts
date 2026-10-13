/**
 * Re-exports the shared connection singleton. The connection itself lives in
 * `shared/lib/db.ts` so `runtime/` can persist to the same sqlite file
 * without importing `control/` (boundary rule, design.md §3.1). Kept here so
 * `control/index.ts` and existing callers don't need to change.
 */
export { getDatabase, initDatabase } from "../../shared/lib/db.ts";
