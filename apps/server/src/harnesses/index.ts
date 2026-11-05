import type { Harness } from "./harness.ts";
import { opencodeHarness } from "./opencode.ts";
import { piHarness } from "./pi.ts";

/** The harnesses a sandbox can run, by catalog id (the toolbox's `harness`
 * and the `atelier.dev/harness` annotation). */
const HARNESSES: Record<string, Harness> = {
  opencode: opencodeHarness,
  pi: piHarness,
};

/** The harness for a catalog id; `undefined` for an unknown one. */
export function findHarness(id: string | undefined): Harness | undefined {
  return id !== undefined && Object.hasOwn(HARNESSES, id)
    ? HARNESSES[id]
    : undefined;
}
