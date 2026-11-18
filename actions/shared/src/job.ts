/**
 * What an action's job prints: log lines, and annotations on the run (workflow
 * commands), plus reading its inputs from the environment. Every message goes
 * on one line: messages carry the agent's text and servers', and the runner
 * reads a line starting with `::` as a command.
 */

/** `text` on one line. */
function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, " ");
}

export interface Job {
  /** A line of the job's log, prefixed with the action's name. */
  log(message: string): void;
  /** A warning on the run, not a red check: for what goes wrong around the
   * job's work, not in it. */
  warn(message: string): void;
  notice(message: string): void;
  /** Ends the run red, with `message` on its summary. */
  fail(message: string): never;
  /** Environment variable `name`, failing the run with `unset` without it. */
  env(name: string, unset?: string): string;
  /** A whole number of minutes from `name`, else `fallback`. */
  minutes(name: string, fallback: number): number;
}

/** The job of the action `name` (the log's prefix), whose annotations are
 * titled `title`. */
export function job(name: string, title: string): Job {
  const annotate = (kind: "error" | "warning" | "notice", message: string) =>
    // `%` is the commands' escape character.
    console.log(
      `::${kind} title=${title}::${oneLine(message).replaceAll("%", "%25")}`,
    );
  const fail = (message: string): never => {
    annotate("error", message);
    process.exit(1);
  };
  return {
    log: (message) => console.log(`[${name}] ${oneLine(message)}`),
    warn: (message) => annotate("warning", message),
    notice: (message) => annotate("notice", message),
    fail,
    env(variable, unset = `${variable} is not set`) {
      const value = process.env[variable];
      if (!value) fail(unset);
      return value as string;
    },
    minutes(variable, fallback) {
      const value = process.env[variable];
      if (!value) return fallback;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1)
        fail(`${variable} must be a whole number of minutes`);
      return parsed;
    },
  };
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
