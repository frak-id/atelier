/**
 * `/api/launchpad/*` — the non-technical surface (docs/proposals/launchpad.md).
 *
 * Starters are control CRUD, authorized like toolboxes. Everything that
 * crosses into the runtime (launch, phases, sleep/wake/retry/delete) lives in
 * `LaunchpadLifecycle`; these handlers only validate and delegate.
 */
import {
  LaunchRequestSchema,
  StarterInputSchema,
  StarterPatchSchema,
  WorkspacePatchSchema,
} from "@atelier/spec";
import { Elysia, t } from "elysia";
import { createAuthPlugin } from "./auth.plugin.ts";
import type { ServerContainer } from "./container.ts";
import {
  LaunchpadLifecycle,
  type WorkspaceDetail,
} from "./launchpad.lifecycle.ts";
import { requireToolboxOwnerAccess, resolveOwner } from "./toolbox-access.ts";
import { createSandboxForUser, withFreshCredentials } from "./v1.routes.ts";

export function createLaunchpadRoutes(container: ServerContainer) {
  const { control, runtime, jobs } = container;
  const authPlugin = createAuthPlugin(control);
  const lifecycle = new LaunchpadLifecycle({
    control,
    runtime,
    jobs,
    createSandbox: (user, request, sandboxId, progress) =>
      createSandboxForUser(container, user, request, sandboxId, progress),
    resumeBody: (sandboxId) => withFreshCredentials(container, sandboxId),
  });

  const starterRoutes = new Elysia({ prefix: "/starters" })
    .use(authPlugin)
    // ── authoring (owner-scoped, like toolboxes) ──────────────────────────
    .get(
      "/",
      ({ user, query }) =>
        control.starterService.list(
          resolveOwner(control, user.id, query.owner, false),
        ),
      { query: t.Object({ owner: t.Optional(t.String()) }) },
    )
    .post(
      "/",
      ({ user, query, body }) =>
        control.starterService.create(
          resolveOwner(control, user.id, query.owner, true),
          body,
        ),
      {
        query: t.Object({ owner: t.Optional(t.String()) }),
        body: StarterInputSchema,
      },
    )
    .patch(
      "/:id",
      ({ user, params, body }) => {
        const starter = control.starterService.get(params.id);
        requireToolboxOwnerAccess(control, starter, user.id);
        return control.starterService.update(params.id, body);
      },
      { body: StarterPatchSchema },
    )
    .delete("/:id", ({ user, params, set }) => {
      const starter = control.starterService.get(params.id);
      requireToolboxOwnerAccess(control, starter, user.id);
      control.starterService.delete(params.id);
      set.status = 204;
    })
    .post(
      "/:id/launch",
      ({ user, params, body, set }) => {
        const view = lifecycle.launch(user, params.id, body);
        set.status = 202;
        return view;
      },
      { body: LaunchRequestSchema },
    );

  const workspaceRoutes = new Elysia({ prefix: "/workspaces" })
    .use(authPlugin)
    .get("/", ({ user }) => lifecycle.list(user.id))
    .get(
      "/:id",
      ({ user, params }): Promise<WorkspaceDetail> =>
        lifecycle.detail(params.id, user.id),
    )
    .patch(
      "/:id",
      ({ user, params, body }) => lifecycle.rename(params.id, user.id, body),
      { body: WorkspacePatchSchema },
    )
    .post("/:id/sleep", ({ user, params }) =>
      lifecycle.sleep(params.id, user.id),
    )
    .post("/:id/wake", ({ user, params, set }) => {
      const view = lifecycle.wake(params.id, user.id);
      set.status = 202;
      return view;
    })
    .post("/:id/retry", ({ user, params, set }) => {
      const view = lifecycle.retry(user, params.id);
      set.status = 202;
      return view;
    })
    .delete("/:id", async ({ user, params, set }) => {
      await lifecycle.delete(params.id, user.id);
      set.status = 204;
    });

  return new Elysia({ prefix: "/api/launchpad" })
    .use(authPlugin)
    .get("/catalog", ({ user }) => lifecycle.catalog(user.id))
    .use(starterRoutes)
    .use(workspaceRoutes);
}
