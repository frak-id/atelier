# Changesets

This folder is used by [Changesets](https://github.com/changesets/changesets) to track unpublished changes for `@konfeature/opencode-atelier`.

> The other workspace packages (`@frak/atelier-manager`, `@frak/atelier-dashboard`, `@frak/atelier-shared`, root `atelier`) are intentionally listed in `config.json -> ignore` and are versioned via `scripts/bump-version.ts`.

## Workflow

1. Make changes that affect `@konfeature/opencode-atelier`.
2. Run `bun run changeset` and pick a bump (`patch` / `minor` / `major`) plus a short summary.
3. Commit the generated `.changeset/<random-name>.md` file alongside your changes.
4. When the PR is merged into `main`, the `Publish npm` GitHub Action either:
   - Opens a "Version Packages" PR that consumes pending changesets, bumps the version, and updates `CHANGELOG.md`. **Merging that PR triggers the npm publish.**
   - Or, if there are no pending changesets and the version on `main` is ahead of what's on npm, publishes directly.

See the upstream [common-questions](https://github.com/changesets/changesets/blob/main/docs/common-questions.md) doc for more.
