/**
 * What a repository adds to an agent's prompt: the workflow's `instructions`
 * input, and a file read on a branch the agent's work can't change (a PR's
 * target, the base an update starts from), so that the work can't rewrite the
 * rules it's held to.
 */
import type { GitHub } from "./github.ts";
import { statusOf } from "./github.ts";
import type { Job } from "./job.ts";

/** Text the repository adds to the prompt, and where it comes from. */
export interface Instructions {
  source: string;
  text: string;
}

/** Each source is cut to this many characters. */
const MAX_INSTRUCTIONS = 20_000;

/** Whether `path` is a path from the repository's root, as the workflow's
 * `instructions-file` must be. */
export function isRepositoryPath(path: string): boolean {
  return !(
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === ".")
  );
}

/**
 * The repository's instructions: `inline` (the workflow's), and the file
 * `file` at `ref`, if it has one. A file it can't read only warns: the work
 * goes on without it.
 */
export async function repositoryInstructions(
  github: Pick<GitHub, "request">,
  job: Pick<Job, "log" | "warn">,
  from: { inline: string; file: string; ref: string; fileSource: string },
): Promise<Instructions[]> {
  const cut = (source: string, text: string): Instructions => {
    if (text.length > MAX_INSTRUCTIONS)
      job.warn(
        `${source}: only its first ${MAX_INSTRUCTIONS} characters reach the agent`,
      );
    return { source, text: text.slice(0, MAX_INSTRUCTIONS) };
  };
  const instructions: Instructions[] = [];
  if (from.inline)
    instructions.push(cut("the workflow's `instructions`", from.inline));
  if (from.file) {
    const path = from.file.split("/").map(encodeURIComponent).join("/");
    const source = `${from.file} ${from.fileSource}`;
    try {
      const file = await github.request<{
        type?: string;
        encoding?: string;
        content?: string;
      }>(`/contents/${path}?ref=${from.ref}`);
      if (
        file.type === "file" &&
        file.encoding === "base64" &&
        file.content !== undefined
      ) {
        const text = Buffer.from(file.content, "base64").toString().trim();
        if (text) instructions.push(cut(source, text));
      } else job.warn(`${source}: not a file of 1 MB at most, so not read`);
    } catch (error) {
      // The repository has none: nothing to add.
      if (statusOf(error) !== 404) job.warn(`${source} not read: ${error}`);
    }
  }
  for (const { source, text } of instructions)
    job.log(`instructions from ${source}: ${text.length} characters`);
  return instructions;
}
