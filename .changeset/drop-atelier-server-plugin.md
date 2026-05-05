---
"@frak/atelier-manager": minor
"@konfeature/opencode-atelier": minor
---

Remove `opencode-atelier-server` plugin package.

Since atelier now uses full git clones (`--depth 1` was dropped), the root commit hashes
computed by `git rev-list --max-parents=0 HEAD` inside the remote sandbox natively match
the local CLI's commit hashes.

This eliminates the need for the `atelier-preregister` server-side SQLite plugin. The fallback
caching step has been moved completely to the manager via `GuestOps.pinOpencodeProjectIdCache`,
which writes `<workspaceDir>/.git/opencode` right after the repository is cloned and before
the opencode server boots.

This simplifies the architecture, removes fragile SQL bindings to opencode's internal
database, and shrinks the Docker image dependencies.
