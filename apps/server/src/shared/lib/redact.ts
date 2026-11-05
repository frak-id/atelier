/**
 * Redaction for text that may carry an in-pod agent URL. The attach and
 * terminal bridge URLs carry the per-sandbox agent token as `?token=` (the
 * relays dial them bare), so they must never land in an error message, a log
 * line, the database or a tool result as is.
 */

const TOKEN_PARAM = /([?&]token=)[^&#\s]*/gi;

/** `url` (or any text containing one) with its `token` query value masked,
 * for the places a URL helps debugging. */
export function redactAgentUrl(url: string): string {
  return url.replace(TOKEN_PARAM, "$1[redacted]");
}
