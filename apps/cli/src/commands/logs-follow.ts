/** Incremental log tailing shared by `logs --follow` and the cockpit's
 * "Follow logs". Uses the byte-windowed logs endpoint's `nextOffset` so each
 * poll only fetches new output. */
import type { AtelierApi } from "../client.ts";
import { unwrap } from "../client.ts";

export interface FollowOpts {
  /** Poll interval in ms (default 1000). */
  intervalMs?: number;
  /** Abort to stop the loop (e.g. wired to SIGINT). */
  signal?: AbortSignal;
  /** Called with each new chunk of log bytes. */
  onChunk: (chunk: string) => void;
}

/** Stream a process's logs from the current start until aborted. Resolves when
 * the signal aborts. */
export async function followLogs(
  api: AtelierApi,
  id: string,
  name: string,
  opts: FollowOpts,
): Promise<void> {
  const interval = opts.intervalMs ?? 1000;
  let offset = 0;
  while (!opts.signal?.aborted) {
    const { content, nextOffset } = unwrap(
      await api.v1
        .sandboxes({ id })
        .processes({ name })
        .logs.get({ query: { offset } }),
    );
    if (content) opts.onChunk(content);
    // nextOffset only advances when there's new data; keep our cursor.
    if (typeof nextOffset === "number" && nextOffset >= offset) {
      offset = nextOffset;
    }
    if (opts.signal?.aborted) break;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
