/**
 * File ownership for writes into a sandbox, shared by the text and base64
 * paths of `patchFiles`. The agent runs as root, so anything it (or a root
 * exec) creates is root's unless chowned.
 */

/** Same ids the agent's `files/write` uses for `owner`. */
export const OWNER_IDS: Record<string, string> = {
  dev: "1000:1000",
  root: "0:0",
};

export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Shell function `mkdirs DIR UID:GID`: `mkdir -p DIR`, then give the
 * directories that call created (not the ones that already existed) to
 * UID:GID, so the owner of a file can also add files next to it, or move
 * and delete it.
 */
export const MKDIRS_FN = [
  "mkdirs() {",
  '  d=$1; top=""',
  '  while [ ! -e "$d" ]; do top=$d; d=$(dirname "$d"); done',
  '  mkdir -p "$1" || return 1',
  '  [ -z "$top" ] || chown -R "$2" "$top"',
  "}",
].join("\n");
