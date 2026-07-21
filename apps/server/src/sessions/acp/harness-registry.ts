/**
 * The harness extension point for ACP dispatch. `sessions/` stays
 * harness-neutral — it knows only this interface, never a concrete harness.
 *
 * The launch command itself lives in the spec (the `acp` process's `command`
 * field, composed client-side by `@atelier/compose`). What this interface
 * covers is the ACP session-*dispatch* behavior that isn't spec data: how a
 * manager-side model/agent selection maps to `session/set_config_option`
 * assignments (ACP does not standardize model selection).
 *
 * The interface + registry mechanism is kept here (neutral); the concrete
 * opencode adapter lives in `@atelier/compose` and is registered by the
 * server's bootstrap.
 */

/** The model/agent selection a session was configured with, harness-neutral. */
export interface AgentModelSelection {
  model?: { providerID: string; modelID: string };
  agent?: string;
}

/** An ACP `session/set_config_option` assignment. */
export interface SessionConfigAssignment {
  configId: string;
  value: string;
}

export interface HarnessDispatchAdapter {
  /** Stable catalog id, e.g. "opencode". Must match the spec's `acp` process
   * annotation (`atelier.dev/harness`) for the facade to resolve the right
   * session surface. */
  readonly id: string;
  /**
   * Translate a selection into ACP `session/set_config_option` assignments.
   * Adapters that don't support selection return [].
   */
  sessionConfig?(selection: AgentModelSelection): SessionConfigAssignment[];
}

const registry = new Map<string, HarnessDispatchAdapter>();

/** Registration is OPTIONAL — only for harnesses that need a `sessionConfig`
 * translation (opencode). Any ACP-speaking harness works unregistered. */
export function registerHarnessDispatch(adapter: HarnessDispatchAdapter): void {
  registry.set(adapter.id, adapter);
}

/** Unknown/unregistered ids resolve to a pass-through adapter (no
 * `sessionConfig` translation, like pi) rather than throwing: model
 * selection over ACP is an optional capability, not a requirement — a
 * harness the server has never heard of must still dispatch. */
export function resolveHarnessDispatch(
  id: string | undefined,
): HarnessDispatchAdapter {
  if (id === undefined) return { id: "unknown" };
  return registry.get(id) ?? { id };
}
