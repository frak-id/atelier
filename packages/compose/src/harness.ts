/**
 * The harness composer extension point (atelier-v2 §3: "the harness
 * composers (today's `harness-adapter.ts` + `opencode-*.ts` knowledge …) →
 * files + the acp process + annotations"). The runtime has no concept of a
 * "harness" — only `@atelier/compose` and its consumers do.
 *
 * A `HarnessComposer` turns harness-specific options into a `SpecFragment`:
 * the `acp` process (with `stdio: "bridge"`, `primary: true`), any config
 * files it needs, and an `atelier.dev/harness` annotation so the GUI can
 * render "opencode with the linear MCP" instead of "a process named acp"
 * (atelier-v2 §2 "annotations are display hints").
 */
import type { SpecFragment } from "./spec-merge.ts";

export interface HarnessComposer {
  /** Stable catalog id, e.g. "opencode". */
  readonly id: string;
  /** Compose the harness's spec fragment: acp process + config files + annotations. */
  compose(opts?: Record<string, unknown>): SpecFragment;
}

const registry = new Map<string, HarnessComposer>();

/** Register a harness composer (e.g. called at server/CLI bootstrap). */
export function registerHarness(composer: HarnessComposer): void {
  registry.set(composer.id, composer);
}

/** Resolve a registered harness composer by id. Throws if unknown. */
export function resolveHarness(id: string): HarnessComposer {
  const composer = registry.get(id);
  if (!composer) {
    throw new Error(
      `Unknown harness "${id}". Registered: ${listHarnesses().join(", ") || "(none)"}`,
    );
  }
  return composer;
}

/** List the ids of every registered harness composer. */
export function listHarnesses(): string[] {
  return [...registry.keys()];
}
