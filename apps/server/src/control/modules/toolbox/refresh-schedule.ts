/**
 * Toolbox refresh schedules (docs/toolbox-versions.md §10): a cron
 * expression (5 fields or a nickname like `@daily`) read in UTC, parsed by
 * Bun's own cron parser so the console and MCP both accept exactly what
 * the scheduler runs.
 */
import { ValidationError } from "../../../shared/errors.ts";

/** A refresh boots a pod and pushes an artifact: cap how often a schedule
 * may fire so a typo (`* * * * *`) can't turn into a build every minute. */
const MIN_INTERVAL_MS = 60 * 60 * 1000;
/** How many upcoming fires the interval check looks at. */
const FIRES_CHECKED = 24;

function parseNext(schedule: string, from: Date): Date | null {
  try {
    return Bun.cron.parse(schedule, from, { tz: "UTC" });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`invalid refreshSchedule: ${reason}`);
  }
}

/**
 * Throw a `ValidationError` unless `schedule` is a cron expression that
 * fires, at most once an hour.
 */
export function validateRefreshSchedule(schedule: string): void {
  let previous = parseNext(schedule, new Date());
  if (!previous) {
    throw new ValidationError("refreshSchedule never fires");
  }
  for (let i = 1; i < FIRES_CHECKED; i++) {
    const next = parseNext(schedule, previous);
    if (!next) return;
    if (next.getTime() - previous.getTime() < MIN_INTERVAL_MS) {
      throw new ValidationError(
        "refreshSchedule must not run more than once an hour",
      );
    }
    previous = next;
  }
}

/** The first fire strictly after `from`, as ISO, or null when the schedule
 * never fires again. Assumes a schedule `validateRefreshSchedule` accepted. */
export function nextRefreshAt(schedule: string, from: Date): string | null {
  try {
    return Bun.cron.parse(schedule, from, { tz: "UTC" })?.toISOString() ?? null;
  } catch {
    return null;
  }
}
