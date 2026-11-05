/**
 * `/v1/*` — the whole runtime API (design.md §2 "Runtime API (the whole
 * thing)"). Thin HTTP: authenticate (control), parse, then call the
 * application layer (`sandboxOps`, `toolboxOps`) or the runtime. The runtime
 * itself never sees an unauthenticated caller.
 */
import {
  AddPortRequestSchema,
  type CreateSandboxRequest,
  CreateSandboxRequestSchema,
  ExecRequestSchema,
  ForkSandboxRequestSchema,
  PatchFilesRequestSchema,
  type PrebuildSpec,
  PrebuildSpecSchema,
  ResumeRequestSchema,
  SANDBOX_NAME_ANNOTATION,
  SurfacePortsSchema,
  SurfaceProcessesSchema,
  type ToolsetBuildRequest,
  ToolsetBuildRequestSchema,
  type ToolsetRef,
  ToolsetRefSchema,
  UpdateSandboxRequestSchema,
} from "@atelier/spec";
import { Elysia, sse, t } from "elysia";
import type { JobRecord } from "../runtime/index.ts";
import { NotFoundError, ValidationError } from "../shared/errors.ts";
import { OWNER_ID_METADATA } from "../shared/lib/git-attribution.ts";
import { createAuthPlugin } from "./auth.plugin.ts";
import type { ServerContainer } from "./container.ts";
import {
  accessibleSandboxes,
  requireSandboxAccess,
  requireSourceAccess,
  sandboxAccessGuard,
} from "./sandbox-guard.ts";
import {
  closeUpstream,
  isUserInput,
  openUpstreamRelay,
  relayMessage,
} from "./ws-relay.ts";

/** Parse `GET /v1/sandboxes?metadata=`: a JSON object of string → string
 * (already URL-decoded). Absent is no filter; anything else is a 400. */
function parseMetadataFilter(raw?: string): Record<string, string> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError("metadata must be a JSON object");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((v) => typeof v !== "string")
  ) {
    throw new ValidationError(
      "metadata must be a JSON object of string values",
    );
  }
  return parsed as Record<string, string>;
}

/** `GET /v1/sandboxes?owner=`: `me` is the caller. */
function ownerFilter(owner: string | undefined, userId: string) {
  return owner === "me" ? userId : owner;
}

export function createV1Routes(container: ServerContainer) {
  const { runtime, control, jobs, idle, sandboxOps, toolboxOps } = container;
  const authPlugin = createAuthPlugin(control);

  // The durable, observable queue for long runtime ops (prebuild bake, toolset
  // build/capture, sandbox spawn, image build). POSTs to those endpoints answer
  // `202` with a job; clients poll `GET /jobs/:id`, watch `GET /jobs`, stream
  // `GET /jobs/events` (SSE), read `GET /jobs/:id/logs`, and can `cancel`.
  //
  // These live in their OWN prefixed sub-app (like `agentRoutes` in
  // sessions.routes) rather than inline on the `/v1` app: an async-generator
  // route (the `/events` SSE feed) sharing a router tree with a static child
  // under a param node (`/jobs/:id/logs`) trips a memoirist (Elysia router)
  // registration bug that 404s one of them. An isolated sub-router avoids it.
  const jobRoutes = new Elysia({ prefix: "/jobs" })
    .use(authPlugin)
    .get("/", ({ query }) => jobs.list(query.limit ?? 200), {
      query: t.Object({ limit: t.Optional(t.Number()) }),
    })
    .get("/:id", ({ params }) => jobs.get(params.id), {
      params: t.Object({ id: t.String() }),
    })
    // Live log tail for a job (build step output). Mirrors the image builder's
    // `{ status, log }` shape; the console polls it while the job is active.
    .get(
      "/:id/logs",
      ({ params }) => {
        const job = jobs.get(params.id);
        return { status: job.status, log: jobs.getLog(params.id) };
      },
      { params: t.Object({ id: t.String() }) },
    )
    .post("/:id/cancel", ({ params }) => jobs.cancel(params.id), {
      params: t.Object({ id: t.String() }),
    })
    .get("/events", async function* ({ request }) {
      const controller = new AbortController();
      const queue: JobRecord[] = [];
      let notify: (() => void) | null = null;
      request.signal.addEventListener("abort", () => {
        controller.abort();
        notify?.();
        notify = null;
      });

      jobs.subscribe(controller.signal, (job) => {
        queue.push(job);
        notify?.();
        notify = null;
      });

      let eventId = 0;
      while (!request.signal.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          if (request.signal.aborted) break;
        }
        while (queue.length > 0) {
          const job = queue.shift();
          if (!job) continue;
          eventId++;
          yield sse({ id: eventId, event: "job", data: job });
        }
      }
      controller.abort();
    });

  return (
    new Elysia({ prefix: "/v1" })
      .use(authPlugin)
      .use(jobRoutes)
      // The access rule (control/sandbox-access.ts) on every
      // `/v1/sandboxes/:id/*` path: one guard for all sandbox routes,
      // fork source and toolsets capture included. The attach socket
      // re-checks in `open`, where the upgrade carries no resolved user.
      .onBeforeHandle(sandboxAccessGuard(container, "/v1/sandboxes/"))
      // ── images ─────────────────────────────────────────────────────────
      .get("/images", () => container.images.listImages())
      .get("/images/templates", () => container.images.listTemplates())
      .get(
        "/images/:name",
        ({ params }) => {
          const record = container.images.getImage(params.name);
          if (!record) throw new NotFoundError("Image", params.name);
          return record;
        },
        { params: t.Object({ name: t.String() }) },
      )
      .get(
        "/images/:name/logs",
        ({ params }) => {
          const record = container.images.getImage(params.name);
          if (!record) throw new NotFoundError("Image", params.name);
          return {
            status: record.status,
            log: container.images.getBuildLog(params.name),
          };
        },
        { params: t.Object({ name: t.String() }) },
      )
      .post(
        "/images",
        async ({ body, user, set }) => {
          control.defaultOrg.requireServerAdmin(user.id);
          const record = await container.images.buildSeed(body.seed, {
            force: body.force,
          });
          set.status = 202;
          return record;
        },
        {
          body: t.Object({
            seed: t.String(),
            force: t.Optional(t.Boolean()),
          }),
        },
      )
      .post(
        "/images/register",
        ({ body, user }) => {
          control.defaultOrg.requireServerAdmin(user.id);
          return container.images.registerExternal(body.name, body.ref);
        },
        { body: t.Object({ name: t.String(), ref: t.String() }) },
      )
      .delete(
        "/images/:name",
        ({ params, user, set }) => {
          control.defaultOrg.requireServerAdmin(user.id);
          container.images.deleteImage(params.name);
          set.status = 204;
        },
        { params: t.Object({ name: t.String() }) },
      )
      // ── prebuilds ──────────────────────────────────────────────────────
      .get("/prebuilds", () => runtime.listPrebuilds())
      .post(
        "/prebuilds",
        ({ body, query, user, set }) => {
          const job = sandboxOps.startPrebuild(user, body as PrebuildSpec, {
            force: query.force === true,
          });
          set.status = 202;
          return job;
        },
        {
          body: PrebuildSpecSchema,
          query: t.Object({ force: t.Optional(t.Boolean()) }),
        },
      )
      // Save a prebuild's dev servers, no resolve, no bake: applied at boot,
      // to every snapshot of its recipe. Empty lists clear them.
      .patch(
        "/prebuilds/:ref/surface",
        ({ params, body }) => runtime.setPrebuildSurface(params.ref, body),
        {
          params: t.Object({ ref: t.String() }),
          body: t.Object({
            processes: t.Optional(SurfaceProcessesSchema),
            ports: t.Optional(SurfacePortsSchema),
          }),
        },
      )
      .delete(
        "/prebuilds/:ref",
        async ({ params, user, set }) => {
          control.defaultOrg.requireServerAdmin(user.id);
          await runtime.deletePrebuild(params.ref);
          set.status = 204;
        },
        { params: t.Object({ ref: t.String() }) },
      )
      // ── toolsets ───────────────────────────────────────────────────────
      .get("/toolsets", () =>
        runtime.listToolsets().map((entry) => ({
          ...entry,
          harness: toolboxOps.harnessForToolset(entry.name),
        })),
      )
      .post(
        "/toolsets",
        ({ body, user, set }) => {
          const req = body as ToolsetBuildRequest;
          requireSourceAccess(container, user.id, req.source);
          const job = jobs.dispatch(
            {
              kind: "toolset-build",
              target: req.name,
              metadata: req.metadata,
            },
            (signal, log) => runtime.buildToolset(req, signal, log),
          );
          set.status = 202;
          return job;
        },
        { body: ToolsetBuildRequestSchema },
      )
      .post(
        "/toolsets/publish",
        async ({ body, user }) => {
          // Unscoped by toolbox: server admins only (a toolbox's own versions
          // publish through `/api/toolboxes/:id/versions/:versionId/publish`).
          control.defaultOrg.requireServerAdmin(user.id);
          return runtime.publishToolset((body as ToolsetRef).ref);
        },
        { body: ToolsetRefSchema },
      )
      .delete(
        "/toolsets",
        async ({ query, user, set }) => {
          control.defaultOrg.requireServerAdmin(user.id);
          // Throws ConflictError when a live/paused sandbox still has this
          // ref mounted (toolset-overlay-squashfs.md §7) — the shared
          // onError handler (api/index.ts) maps SandboxError subclasses to
          // their `statusCode`, so this surfaces as a 409 with no extra
          // handling needed here.
          runtime.deleteToolset((query as ToolsetRef).ref);
          set.status = 204;
        },
        { query: ToolsetRefSchema },
      )
      // ── sandboxes ──────────────────────────────────────────────────────
      // create is `dispatch`ed (non-blocking, 202 + job); the other lifecycle
      // ops below (pause/resume/snapshot/destroy) are `track`ed — AWAITED so
      // the route returns the resource inline, unpooled so they never queue
      // behind a build.
      .post(
        "/sandboxes",
        ({ body, user, set }) => {
          const job = sandboxOps.startCreate(
            user,
            body as CreateSandboxRequest,
          );
          set.status = 202;
          return job;
        },
        { body: CreateSandboxRequestSchema },
      )
      // Only sandboxes the caller may access. `?metadata=` is a URL-encoded
      // JSON object of string pairs: only sandboxes whose metadata holds
      // every pair. `?owner=me|<userId>` keeps those created by that user.
      .get(
        "/sandboxes",
        ({ query, user }) => {
          const filter = parseMetadataFilter(query.metadata);
          const owner = ownerFilter(query.owner, user.id);
          if (owner !== undefined) {
            // Both filters name the creator: they must agree.
            const named = filter[OWNER_ID_METADATA];
            if (named !== undefined && named !== owner) return [];
            filter[OWNER_ID_METADATA] = owner;
          }
          return idle.decorate(
            accessibleSandboxes(container, user.id, runtime.list(filter)),
          );
        },
        {
          query: t.Object({
            metadata: t.Optional(t.String()),
            owner: t.Optional(t.String()),
          }),
        },
      )
      // Without `generated`: the agent token, pod IP and host keys are
      // server-side credentials, not something every org member reads.
      .get("/sandboxes/:id", async ({ params }) => {
        const { generated: _generated, ...state } = await runtime.get(
          params.id,
        );
        return state;
      })
      // Idle auto-pause view: the operator's rule applied to this sandbox,
      // its activity clocks and the agent's last hour of measurements.
      .get("/sandboxes/:id/activity", ({ params }) => idle.view(params.id))
      // Annotation-only edits: the display name (a blank or `null` name
      // clears it; the console then falls back to the id) and keep-awake
      // (validated against the operator's bounds).
      .patch(
        "/sandboxes/:id",
        ({ params, body, set }) => {
          // Validate first, so a rejected keep-awake changes nothing.
          if (body.keepAwakeUntil !== undefined) {
            sandboxOps.keepAwake(params.id, body.keepAwakeUntil);
          }
          if (body.name !== undefined) {
            const name = body.name?.trim() || undefined;
            runtime.setAnnotation(params.id, SANDBOX_NAME_ANNOTATION, name);
          }
          set.status = 204;
        },
        { body: UpdateSandboxRequestSchema },
      )
      .post("/sandboxes/:id/pause", ({ params }) => sandboxOps.pause(params.id))
      .post(
        "/sandboxes/:id/resume",
        ({ params, body }) => sandboxOps.resume(params.id, body),
        { body: ResumeRequestSchema },
      )
      .delete("/sandboxes/:id", async ({ params, set }) => {
        await sandboxOps.destroy(params.id);
        set.status = 204;
      })
      // ── live mutations ────────────────────────────────────────────────
      .patch(
        "/sandboxes/:id/files",
        async ({ params, body, set }) => {
          await sandboxOps.patchFiles(params.id, body);
          set.status = 204;
        },
        { body: PatchFilesRequestSchema },
      )
      .post(
        "/sandboxes/:id/processes/:name/:action",
        async ({ params, set }) => {
          if (params.action !== "start" && params.action !== "stop") {
            set.status = 501;
            return { error: `Unsupported process action "${params.action}"` };
          }
          await sandboxOps.processAction(params.id, params.name, params.action);
          set.status = 204;
        },
        {
          params: t.Object({
            id: t.String(),
            name: t.String(),
            action: t.String(),
          }),
        },
      )
      .get(
        "/sandboxes/:id/processes/:name/logs",
        async ({ params, query }) =>
          sandboxOps.processLogs(
            params.id,
            params.name,
            query.offset,
            query.limit,
          ),
        {
          query: t.Object({
            offset: t.Optional(t.Number()),
            limit: t.Optional(t.Number()),
          }),
        },
      )
      .post(
        "/sandboxes/:id/ports",
        async ({ params, body, set }) => {
          await runtime.addPort(params.id, body);
          set.status = 204;
        },
        { body: AddPortRequestSchema },
      )
      .post(
        "/sandboxes/:id/exec",
        ({ params, body }) => sandboxOps.exec(params.id, body),
        { body: ExecRequestSchema },
      )
      .post("/sandboxes/:id/snapshot", ({ params }) =>
        sandboxOps.snapshot(params.id),
      )
      // Fork is a spawn: `202` with a `sandbox-create` job whose
      // `metadata.sandboxId` is the copy's pre-allocated id, exactly like
      // `POST /sandboxes`. The job snapshots the source, then boots the copy.
      .post(
        "/sandboxes/:id/fork",
        ({ params, body, user, set }) => {
          const job = sandboxOps.startFork(user, params.id, body);
          set.status = 202;
          return job;
        },
        { body: ForkSandboxRequestSchema },
      )
      // ── attach ─────────────────────────────────────────────────────────
      .ws("/sandboxes/:id/attach/:name", {
        query: t.Object({
          mode: t.Optional(t.Union([t.Literal("rw"), t.Literal("ro")])),
        }),
        async open(ws) {
          // The auth plugin's resolve doesn't reliably guard WS upgrades —
          // check the resolved user explicitly (same pattern as the terminal
          // WS route) so an unauthenticated socket never reaches the agent.
          const user = (ws.data as { user?: { id: string } }).user;
          if (!user) {
            ws.close(4001, "Unauthorized");
            return;
          }
          const { id, name } = ws.data.params;
          // `ro` joins the read-only fan-out; `rw` (default) takes the single
          // writer slot. Pure passthrough — runtime.attach already models both.
          const mode = ws.data.query.mode ?? "rw";
          try {
            requireSandboxAccess(container, user.id, id);
            const { url } = await runtime.attach(id, name, mode);
            openUpstreamRelay(ws, url);
          } catch (err) {
            ws.close(
              4004,
              err instanceof Error ? err.message : "attach failed",
            );
          }
        },
        message(ws, message) {
          // Drop client→upstream bytes for read-only attachments.
          if (ws.data.query.mode === "ro") return;
          if (relayMessage(ws, message) && isUserInput(message)) {
            runtime.touch(ws.data.params.id, "console");
          }
        },
        close(ws) {
          closeUpstream(ws);
        },
      })
  );
}
