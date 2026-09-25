/**
 * The default governance policy: which proposals skip review, and who a
 * memory is visible to when the caller doesn't say. See
 * `docs/research/company-agent-prior-art.md` §4 "Memory governance".
 */

import type {
  Actor,
  MemoryPolicy,
  MemoryScope,
  ProposeMemoryInput,
  Readers,
} from "../types.ts";
import { ORG_PRINCIPAL } from "../types.ts";

export const defaultMemoryPolicy: MemoryPolicy = {
  // Only a user's own stated preferences are low-risk enough to skip
  // review ("I prefer dark mode"); anything about a team, repo, channel
  // or the whole org can be wrong in a way that hurts other people, so it
  // waits for a human.
  autoActivate(input: ProposeMemoryInput, _actor: Actor): boolean {
    return input.scope.kind === "user" && input.kind === "preference";
  },

  defaultReaders(scope: MemoryScope): Readers {
    switch (scope.kind) {
      case "org":
        return [ORG_PRINCIPAL];
      case "team":
        return [`team:${scope.id}`];
      case "repo":
        // A repo *scope* just says what the memory is about ("who owns
        // this service"); it isn't a confidentiality boundary by itself,
        // and most repos are internally visible, so default readers are
        // the whole org. Memories about genuinely private repos should
        // pass explicit `readers` on propose (or a patch later).
        return [ORG_PRINCIPAL];
      case "channel":
        return [`channel:${scope.id}`];
      case "user":
        return [`user:${scope.id}`];
      default:
        return [ORG_PRINCIPAL];
    }
  },
};
