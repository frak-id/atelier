/**
 * Clear the overlayfs opaque flag on the directories a boot's toolsets
 * provide, in the workspace's upper layer, before `/home/dev` is assembled.
 *
 * When something creates a directory in the home that no lower layer has at
 * that moment, overlayfs marks the new upper directory opaque: there is
 * nothing below it to merge. The flag stays when the same upper is later
 * mounted over other lowers. A prebuild bakes with no toolset, so a
 * `~/.local` it creates (mise, gh) is opaque in the snapshot, and every
 * sandbox cloned from it hides its toolsets' `~/.local/bin`. A pause snapshot
 * resumed with a new toolbox has the same problem.
 *
 * Cleared: each declared toolset path and every directory above it (for
 * `~/.local/bin`: `.local` and `.local/bin`). Left alone on purpose: the
 * directories inside a declared path. An in-place update (`pi update`, npm's
 * rename then mkdir) leaves the new package directory opaque, which is what
 * keeps the toolset's older copy hidden under it.
 *
 * It runs as root through the agent's exec with `python3` (every base image
 * has it, `setfattr` is not there), so it needs neither a new agent nor a new
 * image. The script does nothing when `/home/dev` is already mounted (an
 * agent restart re-provisioning a live sandbox): the upper of a mounted
 * overlay must not change. Best-effort: a failure is logged and the boot
 * goes on with the home as it is.
 */
import { createChildLogger } from "../shared/lib/logger.ts";
import type { AgentClient } from "./agent/index.ts";
import { shQuote } from "./registry/builder/builder.types.ts";
import { homeRelative } from "./toolset-fingerprint.ts";

const log = createChildLogger("runtime-boot");

const TIMEOUT_MS = 30_000;

/** Where the script works. Tests point it at a scratch tree and a `user.`
 * xattr. */
export interface UnhideTarget {
  /** The overlay's upper layer (agent `DATA_UPPER`). */
  upper: string;
  /** The overlay mount point (agent `HOME`). */
  home: string;
  /** The opaque xattr. The agent mounts without `userxattr`. */
  xattr: string;
}

const SANDBOX: UnhideTarget = {
  upper: "/data/upper",
  home: "/home/dev",
  xattr: "trusted.overlay.opaque",
};

/* argv: upper, home, xattr, then home-relative paths. Each path is walked
 * from the upper's root one name at a time and the walk stops at anything
 * that is not a real directory, so a symlink in the user's upper never leads
 * root out of it. Prints each directory it cleared. */
const SCRIPT = `
import os, stat, sys
upper, home, xattr = sys.argv[1:4]
paths = sys.argv[4:]
if os.path.ismount(home):
    sys.exit(0)
for rel in paths:
    path = upper
    for name in filter(None, rel.split("/")):
        path = os.path.join(path, name)
        try:
            if not stat.S_ISDIR(os.lstat(path).st_mode):
                break
        except OSError:
            break
        try:
            value = os.getxattr(path, xattr, follow_symlinks=False)
        except OSError:
            continue
        if value == b"y":
            os.removexattr(path, xattr, follow_symlinks=False)
            print(path)
`;

/** The root command clearing the flag for `paths` (declared toolset paths),
 * or undefined when none of them is a home path. */
export function unhideCommand(
  paths: string[],
  target: UnhideTarget = SANDBOX,
): string | undefined {
  const rels = new Set<string>();
  for (const path of paths) {
    try {
      rels.add(homeRelative(path));
    } catch {
      // Refused when the toolset was built, so it provides nothing.
    }
  }
  if (rels.size === 0) return undefined;
  return [
    "python3",
    "-c",
    SCRIPT,
    target.upper,
    target.home,
    target.xattr,
    ...rels,
  ]
    .map(shQuote)
    .join(" ");
}

/** Clear the opaque flag on `paths` and their parents in the sandbox's upper
 * layer. Call it before `materializeToolsets`. Never throws. */
export async function unhideToolsetDirs(
  agent: AgentClient,
  sandboxId: string,
  paths: string[],
): Promise<void> {
  const command = unhideCommand(paths);
  if (!command) return;
  try {
    const res = await agent.exec(sandboxId, command, {
      user: "root",
      timeout: TIMEOUT_MS,
    });
    if (res.exitCode !== 0) {
      log.warn(
        { sandboxId, exitCode: res.exitCode, stderr: res.stderr.trim() },
        "could not clear the opaque flag on toolset directories",
      );
      return;
    }
    const cleared = res.stdout.split("\n").filter(Boolean);
    if (cleared.length > 0) {
      log.info(
        { sandboxId, cleared },
        "cleared the opaque flag on toolset directories",
      );
    }
  } catch (err) {
    log.warn(
      { sandboxId, err },
      "could not clear the opaque flag on toolset directories",
    );
  }
}
