/**
 * The harness extension point for ACP dispatch. `sessions/` stays
 * harness-neutral — it knows only this interface, never a concrete harness.
 *
 * The launch command itself lives in the spec (the `acp` process's `command`
 * field, composed client-side by `@atelier/compose`). What this interface
 * covers is the ACP session-*dispatch* behavior that isn't spec data: which
 * message chunks are the harness reporting on itself rather than the agent's
 * answer.
 *
 * The interface + registry mechanism is kept here (neutral); the concrete
 * adapters live in `@atelier/compose` and are registered by the server's
 * bootstrap.
 */

export interface HarnessDispatchAdapter {
  /** Stable catalog id, e.g. "pi". Must match the spec's `acp` process
   * annotation (`atelier.dev/harness`). */
  readonly id: string;
  /**
   * A startup banner the harness sends as a message chunk right after
   * `session/new`, read from that response's `_meta`; the first chunk with
   * exactly this text is left out of the session's updates.
   */
  startupNotice?(meta: AcpMeta): string | undefined;
  /** Whether a message chunk, by its `_meta`, is a status notice of the
   * harness (or one of its extensions); those are left out too. */
  isNotice?(meta: AcpMeta): boolean;
}

/** An ACP `_meta` object. */
type AcpMeta = Record<string, unknown> | null | undefined;

const registry = new Map<string, HarnessDispatchAdapter>();

/** Registration is OPTIONAL — only for harnesses that say things about
 * themselves in message chunks (pi). Any ACP-speaking harness works
 * unregistered. */
export function registerHarnessDispatch(adapter: HarnessDispatchAdapter): void {
  registry.set(adapter.id, adapter);
}

/** Unknown/unregistered ids resolve to a pass-through adapter rather than
 * throwing: a harness the server has never heard of must still dispatch. */
export function resolveHarnessDispatch(
  id: string | undefined,
): HarnessDispatchAdapter {
  if (id === undefined) return { id: "unknown" };
  return registry.get(id) ?? { id };
}
