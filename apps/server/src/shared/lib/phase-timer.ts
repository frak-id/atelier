import type { createChildLogger } from "./logger.ts";

type ChildLogger = ReturnType<typeof createChildLogger>;

/**
 * Lightweight wall-clock timer for multi-step flows.
 *
 * Wrap each awaited phase in {@link step}, then call {@link end} to emit a
 * single structured log line carrying every per-step duration plus the total.
 * Lines are tagged with `metric` so they can be filtered/aggregated downstream
 * (e.g. `jq 'select(.metric == "sandbox_boot")'`).
 *
 * Durations are wall-clock and measured independently per step, so phases that
 * run concurrently (e.g. inside a `Promise.all`) overlap — the sum of `steps`
 * will not equal `totalMs`, and a skipped phase simply has no key.
 */
export class PhaseTimer {
  private readonly startedAt = Date.now();
  private readonly steps: Record<string, number> = {};

  constructor(
    private readonly log: ChildLogger,
    private readonly base: Record<string, unknown> & { metric: string },
  ) {}

  /** Time an awaited block, recording its duration (ms) under `name`. */
  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const phaseStart = Date.now();
    try {
      return await fn();
    } finally {
      this.steps[name] = Date.now() - phaseStart;
    }
  }

  /** Emit the summary line: per-step breakdown + total wall-clock. */
  end(extra?: Record<string, unknown>): void {
    this.log.info(
      {
        ...this.base,
        ...extra,
        steps: this.steps,
        totalMs: Date.now() - this.startedAt,
      },
      `${this.base.metric} timing`,
    );
  }
}
