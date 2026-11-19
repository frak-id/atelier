/**
 * An action's sandboxes on Atelier, through its MCP (atelier.ts): waiting for
 * one to boot, running commands and the coding agent's turns in it, and
 * destroying it, or the ones a dead job left.
 */
import type { Atelier } from "./atelier.ts";
import { type Job, sleep } from "./job.ts";

/** The home of `dev`, the user Atelier runs a sandbox's agent as, and where it
 * clones a repository. */
export const HOME = "/home/dev";
/** Atelier's limit on a sandbox's name (`SANDBOX_NAME_MAX_LENGTH`). */
export const SANDBOX_NAME_MAX = 64;
const BOOT_TIMEOUT_MS = 10 * 60_000;
/** How long a destroy waits for a sandbox whose create job hasn't landed its
 * record yet (`destroy`). */
const DESTROY_WAIT_MS = 5 * 60_000;

/** The agent's task, as `send_prompt` and `get_task` return it. */
interface Task {
  taskId: string;
  status: "running" | "idle" | "failed" | "cancelled";
  turn: {
    reply?: string;
    error?: string;
    toolCalls?: { title: string; status: string }[];
  };
}

/** When the agent's turns must end: they share it, so they fit in the job's
 * timeout. */
export interface Deadline {
  at: number;
  minutes: number;
}

/**
 * `text` without the GitHub credentials git or gh could print: a URL's user
 * info, a token. The sandbox's are no runner secret, which the log would mask.
 */
export function redact(text: string): string {
  return text
    .replaceAll(/(https?:\/\/)[^\s/@]+@/g, "$1***@")
    .replaceAll(/\b(?:gh[pousr]_\w{20,}|github_pat_\w{20,})/g, "***");
}

export const deadlineIn = (minutes: number): Deadline => ({
  at: Date.now() + minutes * 60_000,
  minutes,
});

export interface Sandboxes {
  /** Destroys the sandboxes Atelier lists with `metadata`, and the ones in
   * `known` (it can't list one whose record hasn't landed yet). */
  destroyAll(
    metadata: Record<string, string>,
    known?: readonly string[],
  ): Promise<void>;
  /** Destroys sandbox `id`; never throws. */
  destroy(id: string): Promise<void>;
  waitUntilRunning(id: string): Promise<void>;
  /** Runs `command` in `cwd`; a non-zero exit throws, with its stderr. */
  exec(id: string, command: string, cwd: string): Promise<string>;
  /** Sends the prompt (a new task in the sandbox, or a follow-up turn of
   * `taskId`) and waits for the agent's turn, until `deadline`. `label` names
   * the agent in the log, where several can run at once. */
  runTurn(
    target: { sandboxId: string; cwd: string } | { taskId: string },
    prompt: string,
    deadline: Deadline,
    label?: string,
  ): Promise<Task>;
}

/**
 * The sandboxes of a job (`job` logs). `leftover` says what destroys a sandbox
 * this job couldn't, in the warning it gets.
 */
export function sandboxes(
  atelier: Atelier,
  job: Pick<Job, "log" | "warn">,
  leftover: string,
): Sandboxes {
  const { log, warn } = job;

  /**
   * Until its create job lands its record (once the source is resolved: baking
   * a missing prebuild takes minutes), Atelier can't destroy a sandbox, though
   * `get_sandbox` finds it, `creating`: the destroy is tried again until it
   * lands, DESTROY_WAIT_MS at most. Past that, a warning.
   */
  async function destroy(id: string): Promise<void> {
    const deadline = Date.now() + DESTROY_WAIT_MS;
    for (;;) {
      try {
        await atelier.call("destroy_sandbox", { id });
        log(`sandbox ${id} destroyed`);
        return;
      } catch (error) {
        const exists = await atelier
          .call("get_sandbox", { id })
          .then(() => true)
          .catch(() => false);
        if (!exists) {
          // Gone already, or never made: nothing to destroy.
          log(`sandbox ${id} not destroyed: ${error}`);
          return;
        }
        if (Date.now() > deadline) {
          warn(`sandbox ${id} not destroyed (${error}): ${leftover}`);
          return;
        }
        log(`sandbox ${id} not destroyed yet (${error}): trying again`);
        await sleep(15_000);
      }
    }
  }

  return {
    destroy,
    async destroyAll(metadata, known = []) {
      const { sandboxes } = await atelier.call<{ sandboxes: { id: string }[] }>(
        "get_sandbox",
        { metadata },
      );
      const ids = new Set([...known, ...sandboxes.map(({ id }) => id)]);
      for (const id of ids) {
        log(`destroying sandbox ${id}`);
        await destroy(id);
      }
    },

    async waitUntilRunning(id) {
      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      for (;;) {
        const { status } = await atelier.call<{ status: string }>(
          "get_sandbox",
          { id, waitSeconds: 50, until: "running" },
        );
        if (status === "running") return;
        if (status === "error" || status === "stopped")
          throw new Error(`sandbox ${id} is ${status}`);
        if (Date.now() > deadline)
          throw new Error(
            `sandbox ${id} still ${status} after the boot timeout`,
          );
      }
    },

    async exec(id, command, cwd) {
      const result = await atelier.call<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>("exec", {
        id,
        command,
        cwd,
        // Under the client's 120 s per request: `exec` isn't retried.
        timeoutMs: 100_000,
      });
      if (result.exitCode !== 0)
        throw new Error(
          `\`${command}\` exited ${result.exitCode}: ${redact(result.stderr.trim())}`,
        );
      return result.stdout.trim();
    },

    async runTurn(target, prompt, deadline, label = "agent") {
      let task = await atelier.call<Task>("send_prompt", {
        ...target,
        prompt,
      });
      let logged = 0;
      while (task.status === "running") {
        if (Date.now() > deadline.at) {
          await atelier
            .call("manage_task", { taskId: task.taskId, action: "cancel" })
            .catch(() => {});
          throw new Error(
            `the ${label} took longer than ${deadline.minutes} minutes`,
          );
        }
        task = await atelier.call<Task>("get_task", {
          taskId: task.taskId,
          waitSeconds: 50,
        });
        // The job's log tells what the agent did: each tool call once (the
        // list only comes with a running turn).
        const calls = task.turn.toolCalls ?? [];
        for (const call of calls.slice(logged))
          log(`${label}: ${call.title.replaceAll("\n", " ").slice(0, 160)}`);
        logged = Math.max(logged, calls.length);
      }
      if (task.status !== "idle")
        throw new Error(
          `the ${label}'s task is ${task.status}: ${task.turn.error ?? ""}`,
        );
      log(`${label} done: ${task.turn.reply ?? ""}`);
      return task;
    },
  };
}
