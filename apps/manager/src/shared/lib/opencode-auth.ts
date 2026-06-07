/**
 * Build Authorization header for OpenCode Basic Auth.
 * Returns undefined if no password is set (backward compat).
 */
export function buildOpenCodeAuthHeaders(
  password: string | undefined,
): Record<string, string> | undefined {
  if (!password) return undefined;
  const encoded = Buffer.from(`opencode:${password}`).toString("base64");
  return { Authorization: `Basic ${encoded}` };
}

// Healthy `opencode serve` answers /health in <100ms; short on purpose so a
// wedged request fails fast and the poll loop can retry quickly during boot.
export const OPENCODE_REQUEST_TIMEOUT_MS = 250;

// The OpenCode SDK has no per-request timeout, so a request that hangs (e.g.
// one that lands while `opencode serve` is still wiring up its handler) never
// settles and freezes the readiness poll loop forever. Abort each request so
// the loop can retry instead of leaving the sandbox stuck "creating".
export function createTimeoutFetch(timeoutMs: number): typeof fetch {
  const timeoutFetch = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    return fetch(input, { ...init, signal });
  };
  return timeoutFetch as typeof fetch;
}
