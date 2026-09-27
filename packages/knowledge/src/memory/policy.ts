/**
 * The default governance policy: which proposals skip review. See
 * `docs/research/company-agent-prior-art.md` §4 "Memory governance".
 */

import type { Actor, MemoryPolicy, ProposeMemoryInput } from "../types.ts";

export const defaultMemoryPolicy: MemoryPolicy = {
  // Only a user's own stated preferences are low-risk enough to skip
  // review ("I prefer dark mode"); anything about a team, repo, channel
  // or the whole org can be wrong in a way that hurts other people, so it
  // waits for a human.
  autoActivate(input: ProposeMemoryInput, _actor: Actor): boolean {
    return input.scope.kind === "user" && input.kind === "preference";
  },
};
