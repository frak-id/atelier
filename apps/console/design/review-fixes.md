# Console Redesign — Consolidated Review Fixes (decisions locked)

Apply ALL of the following to `apps/console/src` (+ noted files). Decisions are
already made — do not re-litigate; just implement cleanly. Full reviewer
artifacts: `apps/console/design/review-*.md`. After all fixes, run
`bun run --filter '@atelier/console' typecheck` and `bun run check`, fixing
anything you introduce. Do not commit.

## P0 — Security / correctness (must fix)

1. **Shell-safe repo clone** — `lib/templates.ts` `withRepoClone`.
   - Validate `repoUrl` matches `^https?:\/\/[^\s]+$`; if not, throw an Error
     with a clear message (the gallery already collects it via an input — let
     the caller surface the error).
   - Single-quote-escape BOTH `repoUrl` and the derived `name` before
     interpolation, e.g. `const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;`
     then `` `git clone --depth 1 ${q(repoUrl)} ${q(`/home/dev/${name}`)}` ``.
   - This fixes both the injection risk and the wrong-path clone on URLs with
     spaces. (Reviewers: correctness F1, TS #3, standards M-2.)

2. **Fleet abort/delete loading indicator never shows** — `routes/index.tsx`
   `FleetSessionsSection`. After the hook consolidation in #6 below, pass:
   `abortingId={abort.isPending ? abort.variables?.sessionId : undefined}` and
   the same for `deletingId`. (Correctness F2.)

3. **Empty-todos expand shows a blank gap** — `components/sessions-by-repo.tsx`
   `SessionRow`. Add an explicit branch: when `expanded && todos && todos.length
   === 0`, render `<p class="mt-1 text-sm text-muted-foreground">No todos.</p>`.
   (Correctness F3.)

## P1 — Simplification / dedup (locked decisions)

4. **Delete the dead `.dark {}` block** in `src/index.css`. `:root` already
   carries the dark defaults and `ThemeProvider` toggles `.light`/`.dark`; the
   `.dark {}` block is an exact duplicate no-op. Keep `:root` (dark) + `.light`
   override only. Verify the app still defaults to dark and light toggle works.
   (Simplicity M2, standards I-1.)

5. **`Button.loading`: use it, don't strand it.** Keep the prop but:
   - Use `loading={…}` (+ keep `disabled`) in the 3 new callers that hand-roll
     `{x ? <Loader2 className="animate-spin"/> : <Icon/>}`:
     `sessions-by-repo.tsx` (Abort + Delete) and `template-gallery.tsx` (Spawn).
     Remove their inline `Loader2` ternaries + now-unused `Loader2` imports.
   - Fix the `asChild` branch to force `disabled: disabled || loading` (today it
     only sets `aria-busy`, leaving the element enabled). Update the JSDoc to
     match reality. (Simplicity M1, maintainability H1, standards L-2.)

6. **Consolidate the session-mutation hooks** — `api/queries/sessions.ts`.
   Replace the duplicated `useAbortSession`/`useAbortSessionAnywhere` (and the
   delete pair) with ONE hook each whose mutation argument is
   `{ sandboxId: string; sessionId: string }`. Update BOTH call sites:
   - `sandboxes.$sandboxId.sessions.tsx`: `abort.mutate({ sandboxId, sessionId:
     session.id })`, and `abortingId={abort.isPending ? abort.variables?.sessionId
     : undefined}` (same for delete).
   - `routes/index.tsx`: already passes the object; wire the `abortingId`/
     `deletingId` from `.variables?.sessionId` (this is what P0 #2 needs).
   Removes ~60 lines of copy-paste. (Simplicity M4, correctness F2.)

7. **Collapse the `persona` vs `OPERATOR_DEFAULT_IDS` divergence** —
   `lib/templates.ts` + `template-gallery.tsx`. Remove the decorative
   `TemplatePersona` type and the `persona` field from every template (it is
   never used for filtering). Keep `OPERATOR_DEFAULT_IDS` as the single explicit
   operator set. Add and export `ALL_TEMPLATES = [...TEMPLATES, ...TEMPLATES_EXTRA]`
   and use it in the gallery so both lens branches share one array. (Simplicity
   M3+m4.)

8. **Remove the unused `tabs.tsx` primitive** (`components/ui/tabs.tsx`) — no
   consumer anywhere (verified). YAGNI; re-add when something uses it. Keep
   `tooltip.tsx` (it IS used via `TooltipProvider`). (Standards L-1, simplicity.)

9. **Inline the `FleetLiveSubscriptions` wrapper** — `routes/index.tsx`. It only
   does `sandboxIds.map(id => <FleetLiveSubscription key={id} sandboxId={id}/>)`.
   Inline that map into `FleetSessionsSection`; delete the wrapper. Keep the
   singular `FleetLiveSubscription` (hooks can't run in a map). (Simplicity m3.)

10. **Drop the speculative `initialTab` prop** — `components/immersive-view.tsx`.
    "Open" = terminal only. Hardcode `useState(TERMINAL_TAB)` internally; remove
    the prop and update call sites. (Simplicity m1.)

## P2 — Type/a11y/clarity (cheap, do them)

11. **Exhaustive switches** — `lib/status-presentation.ts`:
    - `sessionStatusPresentation`: replace `default` with explicit `case "idle"`
      plus a `default: { const _e: never = status; … }` guard.
    - `riskBadgeVariant`: add explicit `case "low"` + `never` guard. (TS #1, #2.)

12. **`SegmentedControl` ARIA** — `components/ui/segmented-control.tsx`. Replace
    `role="tablist"`/`role="tab"`/`aria-selected` with `role="radiogroup"` on the
    container and `role="radio"`/`aria-checked` on each button (no tabpanels
    exist). (Simplicity m2, standards M-1.)

13. **Name the concrete type** — `template-gallery.tsx`: change
    `onSpawn: (request: ReturnType<typeof templateToRequest>) => void` to import
    and use `CreateSandboxRequest` from `@atelier/spec` (both `TemplateGallery`
    and `TemplateCard`). (TS #4.)

14. **`spawnFromSpec` double-toolboxes** — `routes/spawn.tsx`. Make the template
    path call `onSpawn={(request) => spawnFromSpec(request)}` and have
    `spawnFromSpec` accept the full `CreateSandboxRequest` (toolboxes already
    embedded), OR keep the existing `(spec, toolboxes?)` signature for the other
    callers but stop passing `request.toolboxes` twice. Pick the minimal change
    that removes the redundant second arg without breaking other call sites.
    (TS #5, standards I-2.)

15. **`sandboxDetailQuery("")` guard** — `routes/index.tsx`. Use
    `sandboxDetailQuery(openSandboxId!)` with a one-line `// biome-ignore`/comment
    explaining it's non-null when `enabled`, instead of the `?? ""` placeholder.
    (TS #6.)

16. **`repoLabel` lives in the wrong module** — move it from
    `status-presentation.ts` to `lib/formatters.ts` (next to `formatRelativeTime`);
    update imports in `sessions-by-repo.tsx`. (Maintainability M1.)

17. **Unexport `groupSessionsByRepo`** in `sessions-by-repo.tsx` (no external
    consumer). (Maintainability M3.)

18. **`multi-terminal.tsx` ref idiom** — pass `ref={session.id === activeId ?
    activeHandleRef : null}` (null, not undefined) so the imperative handle
    clears cleanly on tab switch/unmount. (Correctness F5.)

19. **Permission needle** — `status-presentation.ts` `permissionPresentation`:
    add a bare `"run"` (and keep `"run "`) to the exec/shell needle set so a
    verbatim `run` permission is classified correctly. (Standards I-3.)

## Deferred (leave a short `// TODO(review):` comment, do NOT implement now)

- **`ImmersiveView` focus trap** (standards L-3): the full-screen overlay lacks a
  focus trap. Larger change (Radix Dialog / focus-trap). Add a TODO at the
  overlay root noting it should adopt a focus trap.
- **Fleet per-sandbox query errors swallowed** (correctness F4): `q.data ?? []`
  hides `isError`. Add a TODO in `useFleetSessions` noting failing sandboxes
  should surface an error indicator (ties into the future server aggregate).
- **`variant` vs `badgeVariant` naming split** (maintainability M2): leave as-is
  to avoid churn; not worth the ripple this pass.

## Verify at the end
- `bun run --filter '@atelier/console' typecheck` → clean
- `bun run check` (biome) → clean
- `grep -rn 'variant.*"error"' apps/console/src` → none (already confirmed)
- Confirm dark is still the default and the light toggle works after #4.
