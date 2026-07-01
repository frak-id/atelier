import { createChildLogger } from "./logger.ts";

const log = createChildLogger("retry");

export interface RetryOptions {
  /** Maximum number of attempts (including the first). */
  maxAttempts: number;
  /** Initial delay in milliseconds before the first retry. */
  baseDelayMs: number;
  /** Maximum delay in milliseconds between retries. */
  maxDelayMs: number;
  /** Add random jitter to avoid thundering-herd. Defaults to true. */
  jitter?: boolean;
  /** Label used in log messages. */
  label?: string;
}

/**
 * Execute `fn` with exponential backoff.
 *
 * Retries on any thrown error up to `maxAttempts` times.  The delay between
 * attempts doubles each time, capped at `maxDelayMs`, with optional jitter.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    jitter = true,
    label = "operation",
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts) break;

      const exponentialDelay = baseDelayMs * 2 ** (attempt - 1);
      const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
      const delay = jitter
        ? cappedDelay * (0.5 + Math.random() * 0.5)
        : cappedDelay;

      log.warn(
        { attempt, maxAttempts, delayMs: Math.round(delay), label, error },
        `${label} failed, retrying`,
      );

      await Bun.sleep(Math.round(delay));
    }
  }

  throw lastError;
}
