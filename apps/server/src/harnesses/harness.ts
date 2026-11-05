/**
 * A harness: the agent CLI a sandbox runs behind its `acp` process. The
 * runtime has no concept of one; the server composes the spec fragment and
 * knows how to read the harness's own chatter in the ACP stream.
 */
import type { SpecFragment } from "./spec-merge.ts";

/** An ACP `_meta` object. */
export type AcpMeta = Record<string, unknown> | null | undefined;

export interface Harness {
  /** Compose the harness's spec fragment: the `acp` process (stdio bridge,
   * primary), its config files and an `atelier.dev/harness` annotation. */
  compose(opts?: Record<string, unknown>): SpecFragment;
  /** A startup banner the harness sends as a message chunk right after
   * `session/new`, read from that response's `_meta`; the first chunk with
   * exactly this text is left out of a session's updates. */
  startupNotice?(meta: AcpMeta): string | undefined;
  /** Whether a message chunk, by its `_meta`, is a status notice of the
   * harness (or one of its extensions); those are left out too. */
  isNotice?(meta: AcpMeta): boolean;
}
