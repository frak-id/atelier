/**
 * Auto-resume on access: a request for a paused sandbox (a tool or preview
 * URL through the ingress, an SSH connection) resumes it instead of failing.
 * The resume is a tracked job in the feed like a manual one; concurrent
 * requests share it. Only `paused` sandboxes wake (see `decideWake`).
 */
import type { ServerContainer } from "./container.ts";
import { withFreshCredentials } from "./v1.routes.ts";

/** After a wake-up resume ends without the sandbox running (it failed), wait
 * this long before another request may start one: a broken sandbox must not
 * be resumed on every page refresh. */
const RETRY_COOLDOWN_MS = 30_000;

const lastStarted = new Map<string, number>();

/** Whether a resume of the sandbox is running right now. */
export function isResuming(
  container: ServerContainer,
  sandboxId: string,
): boolean {
  return (
    container.jobs.findActive(
      (job) => job.kind === "sandbox-resume" && job.target === sandboxId,
    ) !== undefined
  );
}

/**
 * Make sure a paused sandbox is resuming. Returns whether the sandbox is
 * paused (so the caller should answer "waking up"): a resume is already
 * running, was just started, or failed recently and is cooling down. Returns
 * false for any other status, which needs no wake-up.
 */
export function ensureResuming(
  container: ServerContainer,
  sandboxId: string,
  now: number = Date.now(),
): boolean {
  const { runtime, jobs } = container;
  if (runtime.getStatus(sandboxId) !== "paused") return false;
  if (isResuming(container, sandboxId)) return true;
  const started = lastStarted.get(sandboxId);
  if (started !== undefined && now - started < RETRY_COOLDOWN_MS) return true;
  lastStarted.set(sandboxId, now);
  jobs.dispatch(
    {
      kind: "sandbox-resume",
      target: sandboxId,
      metadata: { trigger: "wake" },
      unpooled: true,
    },
    async () =>
      runtime.resume(
        sandboxId,
        await withFreshCredentials(container, sandboxId),
      ),
  );
  return true;
}

/**
 * Wait until `getStatus` says `running`, polling every `pollMs`, up to
 * `timeoutMs`. Resolves true once it runs; false on timeout, or as soon as it
 * cannot get there: the sandbox is gone, settled in `error`/`stopped`, or is
 * `paused` with no resume in flight (the wake-up resume failed).
 */
export async function waitForRunning(
  getStatus: () => string | undefined,
  {
    waking,
    timeoutMs,
    pollMs = 1000,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now = Date.now,
  }: {
    /** Whether a resume of this sandbox is in flight. */
    waking: () => boolean;
    timeoutMs: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const status = getStatus();
    if (status === "running") return true;
    const pending = status === "creating" || (status === "paused" && waking());
    if (!pending || now() >= deadline) return false;
    await sleep(pollMs);
  }
}
