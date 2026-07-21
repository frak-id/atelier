# Toolset-provided tools can't be updated in place (`npm ENOENT` on overlayfs)

## Summary

Running `pi update --all` (or the equivalent `npm install -g --prefix
~/.local …`) inside a sandbox fails with `ENOENT` when it tries to replace a
tool that was delivered by a **toolset**:

```
npm error code ENOENT
npm error syscall mkdir
npm error path /home/dev/.local/lib/node_modules/@earendil-works/pi-coding-agent
npm error errno -2
npm error enoent ENOENT: no such file or directory, mkdir '/home/dev/.local/lib/node_modules/@earendil-works/pi-coding-agent'
```

This is **not** an npm, registry, or permissions problem. It is a structural
conflict between how tools are delivered (read-only toolset layer) and how the
tool tries to update itself (npm's atomic in-place replace) on the sandbox's
overlay filesystem.

Observed on sandbox `1ocm167zlo19` (staging, `atelier-v2-sandboxes`).

## Environment

`/home/dev` is an **overlayfs** whose lower layer is the read-only toolset
image:

```
/home/dev  overlay  rw,
  lowerdir=/run/toolsets/f98dcf96…:/home/skel
  upperdir=/data/upper
  workdir=/data/work
  redirect_dir=nofollow, index=off, xino=off, metacopy=off, userxattr
```

The toolset itself is a read-only **erofs** image mounted from a loop device:

```
/run/toolsets/f98dcf96…  erofs  /dev/loop0  ro,relatime,user_xattr,cache_strategy=readaround
```

`pi` is baked into that read-only layer:

- `~/.local/lib/node_modules/@earendil-works/pi-coding-agent` (v0.80.7) lives on
  the toolset lowerdir (epoch `1970` mtime — a reproducible-build erofs blob).
- `~/.local/bin/pi` is a symlink into it:
  `../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`.

## Root cause

`pi update` runs `npm install -g --prefix ~/.local @earendil-works/pi-coding-agent@…`.
npm's install ("reify") is **atomic**: for each package it is replacing it

1. **renames** the existing directory to a hidden temp name
   (`@earendil-works/pi-coding-agent` → `@earendil-works/.pi-coding-agent-ggZSgfkp`),
   and does the same to `bin/pi`, then
2. **`mkdir`s** a fresh directory at the original path and extracts into it.

From npm's debug log:

```
95 silly reify mark retired [
95 silly reify   '/home/dev/.local/lib/node_modules/@earendil-works/pi-coding-agent',
95 silly reify   '/home/dev/.local/bin/pi'
95 silly reify ]
96 silly reify moves {
96 silly reify   '…/@earendil-works/pi-coding-agent': '…/@earendil-works/.pi-coding-agent-ggZSgfkp',
96 silly reify   '…/bin/pi': '…/bin/.pi-Udye7H0S'
96 silly reify }
97 verbose stack Error: ENOENT: no such file or directory, mkdir '…/@earendil-works/pi-coding-agent'
```

The directory being renamed **physically lives on the read-only lowerdir**.
The overlay is mounted in **`userxattr` mode** (the rootless / user-namespaced
variant used under kata). `userxattr` forces `redirect_dir=nofollow` and
`metacopy=off`, because overlay redirect/metacopy metadata can't be stored
safely in unprivileged `user.overlay.*` xattrs. In that mode, **renaming a
directory that originates from the lowerdir across the lower→upper boundary is
not reliably supported**, and npm's rename-then-`mkdir` sequence returns
`ENOENT` on the first update (before the directory tree has been copied up into
the writable upper layer).

### Why it looked "persistent" then "self-healed"

- The failure reproduced across ~18 minutes / 3 attempts, so it is not a simple
  one-off race.
- Once the directory tree was forced into the writable upper layer (any
  successful write into it — e.g. a manual `mkdir -p`), the **same** `npm
  install` succeeded (`changed 131 packages`, 0.80.7 → 0.80.8, exit 0).
- Isolated manual repros of "rename a lower-origin dir, then `mkdir` the old
  name" now succeed, because the parent tree is already copied up. The failure
  window is specifically the **first** in-place replacement of a lower-only
  (toolset-provided) directory tree.

## The deeper problem (independent of the ENOENT)

Even when the update succeeds, it writes into the **ephemeral upper layer**
(`/data/upper`), so it only *shadows* the toolset's copy of pi. That change is
discarded whenever:

- the toolset layer is refreshed / re-versioned, or
- the sandbox is rebuilt / the overlay is reassembled.

So **updating a toolset-provided tool in place is the wrong model regardless of
the overlay bug** — the update is not durable and fights the platform's
version management.

## Recommendations (ranked)

1. **Treat toolset-provided tools as platform-managed (preferred).**
   If pi is delivered by a toolset, Atelier owns its version. Bump the toolset
   image to update pi, and make in-sandbox `pi update` a no-op / blocked with a
   clear message ("pi is managed by Atelier"). Eliminates the whole class of
   problem and keeps versions durable.

2. **If in-sandbox self-update must be supported:**
   Don't place the tool on an overlay lowerdir. Install pi into a
   **pure-writable prefix** (a directory on the writable volume, or have the
   toolset ship only a launcher/symlink while the real install lives in a
   non-overlaid `~/.local`). Then npm's rename never crosses the lower→upper
   boundary — the update both works and persists.

3. **Runtime / agent mitigation:**
   The overlay uses `userxattr` because of the user-namespaced kata setup, which
   disables safe `redirect_dir`/`metacopy`. If the overlay could be assembled
   with real `redirect_dir=on,index=on` (trusted xattrs, i.e. not userns-
   restricted), npm's atomic install would be reliable. May not be possible
   under kata's user namespace.

4. **Immediate user workaround (not a real fix):**
   Re-run the update — it tends to succeed on the second pass once the tree is
   copied up. Or pre-copy-up the target first:
   ```
   cp -a ~/.local/lib/node_modules/@earendil-works/pi-coding-agent{,.tmp} \
     && rm -rf ~/.local/lib/node_modules/@earendil-works/pi-coding-agent.tmp
   ```
   then run the update.

## Status

- Sandbox `1ocm167zlo19` was manually nudged and is currently on pi **0.80.8**
  (working).
- **Fresh sandboxes will hit the same wall** on the first `pi update` until the
  delivery model changes (option 1 or 2).

## Next steps / open questions

- Decide between option 1 (platform-managed, block in-sandbox update) and
  option 2 (writable prefix for self-update).
- Locate where the pi toolset is defined and where the agent assembles the
  `/home/dev` overlay, to implement the chosen option.
- Confirm whether kata's user namespace forbids a non-`userxattr` overlay mount
  (rules option 3 in or out).
