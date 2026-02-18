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
