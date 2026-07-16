/**
 * `/v1/*` — the whole runtime API (atelier-v2 §2 "Runtime API (the whole
 * thing)"). Every route: authenticate (control) → enrich the spec (control's
 * two seam mutations) → call `runtime.*(spec)` once. The runtime itself never
 * sees an unresolved secret or an unauthenticated caller.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AddPortRequestSchema,
  AddProcessRequestSchema,
  type CreateSandboxRequest,
  CreateSandboxRequestSchema,
  ExecRequestSchema,
  PatchEnvRequestSchema,
  PatchFilesRequestSchema,
  type PrebuildSpec,
  PrebuildSpecSchema,
  ResumeRequestSchema,
  type SandboxSpec,
  type ToolsetBuildRequest,
  ToolsetBuildRequestSchema,
  type ToolsetCaptureRequest,
  ToolsetCaptureRequestSchema,
  type ToolsetRef,
  ToolsetRefSchema,
} from "@atelier/spec";
import { Elysia, sse, t } from "elysia";
import {
  type JobRecord,
  readContextDockerfile,
  unpackZipContext,
} from "../runtime/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import {
  buildGitAttributionFiles,
  OWNER_ID_METADATA,
} from "../shared/lib/git-attribution.ts";
import { createAuthPlugin } from "./auth.plugin.ts";
import {
  harnessForToolset,
  resolveSelectedToolboxes,
  resolveToolboxHarness,
  resolveToolboxRefs,
  resolveToolboxSurface,
  type ServerContainer,
} from "./container.ts";
import { closeUpstream, openUpstreamRelay, relayMessage } from "./ws-relay.ts";

/** A short, human label for a prebuild job's queue row — the workspace/repo
 * metadata when present, else the source, else "prebuild". */
function prebuildLabel(spec: PrebuildSpec): string {
  return (
    spec.metadata?.workspace ??
    spec.metadata?.repo ??
    spec.repos?.[0]?.url ??
    ("image" in spec.source ? spec.source.image : spec.source.snapshot)
  );
}

/** A short, human label for a sandbox-create job's queue row — the spec's
 * opaque name/workspace metadata when present, else its source. */
function sandboxLabel(req: CreateSandboxRequest): string {
  return (
    req.metadata?.name ??
    req.metadata?.workspace ??
    ("image" in req.source ? req.source.image : req.source.snapshot)
  );
}

/**
 * Merge two name-keyed lists (processes/ports): `base` entries first, then
 * `override` entries — a same-name entry in `override` (the spec's own) wins.
 */
function mergeByName<T extends { name: string }>(
  base: T[],
  override: T[] | undefined,
): T[] | undefined {
  if (!override || override.length === 0)
    return base.length > 0 ? base : undefined;
  const byName = new Map<string, T>();
  for (const e of base) byName.set(e.name, e);
  for (const e of override) byName.set(e.name, e);
  return [...byName.values()];
}

/**
 * Resolve the caller's org for enrichment: first org membership, falling
 * back to their personal org. Both are synchronous control reads — no org
 * header/param support yet, so multi-org users resolve to their first
 * membership (documented Phase 0 simplification, see PHASE0.md).
 */
function resolveOrgId(
  control: ServerContainer["control"],
  userId: string,
): string | undefined {
  const memberships = control.orgMemberService.getByUserId(userId);
  if (memberships[0]) return memberships[0].orgId;
  return control.userService.getById(userId)?.personalOrgId;
}

/**
 * Shared by `POST /v1/sandboxes` and the `create_sandbox` MCP tool (the
 * "one API, three surfaces" principle, atelier-v2 §4): resolve the caller's
 * org, apply toolbox auto-inject + explicit selectors, run the enrichment
 * seam, merge toolbox-contributed processes/ports, and boot. Both callers
 * pass an authenticated `AuthUser` — there is exactly one enrichment path.
 */
export async function createSandboxForUser(
  container: ServerContainer,
  user: { id: string; username: string; email: string },
  body: CreateSandboxRequest,
) {
  const { runtime, control } = container;
  // The body is a spec plus the high-level references the caller picked
  // (`toolboxes` selectors, a `prebuild` recipe); strip them so the runtime
  // only ever sees a resolved spec.
  const { toolboxes: selectors = [], prebuild, ...specFields } = body;
  let spec = specFields as SandboxSpec;
  // A template built from a prebuild carries the recipe, not a pinned ref:
  // resolve it to the current snapshot (idempotent — a cache hit when
  // unchanged) so an updated prebuild is picked up here.
  if (prebuild) {
    const snapshot = await runtime.prebuild(prebuild, {
      githubToken: control.userService.resolveGitHubToken(user.id),
    });
    spec = { ...spec, source: { snapshot: snapshot.ref } };
  }
  const orgId = resolveOrgId(control, user.id);
  const authorizedKeys = control.sshKeyService.getValidPublicKeys();
  // The sandbox owner (git user): identity for attribution/display + GitHub
  // token for the injected credential helper.
  const owner = {
    id: user.id,
    username: user.username,
    email: user.email,
    githubToken: control.userService.resolveGitHubToken(user.id),
  };
  // Auto-inject org (baseline) then user (personal overlay) toolboxes,
  // oldest-first (R6), then the explicitly-picked ones.
  const [autoInjectRefs, selectedRefs] = await Promise.all([
    resolveToolboxRefs(container, { orgId, userId: user.id }),
    resolveSelectedToolboxes(container, selectors),
  ]);
  // Every toolbox applied to this spawn, as parseable `tb/…` handles — auto-
  // injected refs, picked selectors (incl. process-only ones with no
  // toolset), and any explicit `spec.toolsets`. Drives harness + surface
  // resolution.
  const applied = [
    ...autoInjectRefs,
    ...selectors.map((ref) => ({ ref })),
    ...(spec.toolsets ?? []),
  ];
  // Harness precedence: spec > toolbox > org policy.
  const toolboxHarnessId = resolveToolboxHarness(container, applied);
  const enriched = await control.enrichSpec(spec, orgId, {
    toolboxHarnessId,
    owner,
  });
  // Dedupe materialized refs (a toolbox can be both auto-injected and
  // picked) so the agent never extracts the same artifact twice.
  const seen = new Set<string>();
  const toolsets = [
    ...autoInjectRefs,
    ...selectedRefs,
    ...(enriched.toolsets ?? []),
  ].filter((t) => {
    if (seen.has(t.ref)) return false;
    seen.add(t.ref);
    return true;
  });
  // Merge the processes + ports every applied toolbox contributes (its
  // tool's running surface), keyed by name (spec's own win).
  const surface = resolveToolboxSurface(container, applied);
  const withToolboxes: SandboxSpec = {
    ...enriched,
    toolsets,
    processes: mergeByName(surface.processes, enriched.processes),
    ports: mergeByName(surface.ports, enriched.ports),
  };
  return runtime.create(withToolboxes, { authorizedKeys });
}

export function createV1Routes(container: ServerContainer) {
  const { runtime, control, jobs } = container;
  const authPlugin = createAuthPlugin(control);

  return (
    new Elysia({ prefix: "/v1" })
      .use(authPlugin)
      // ── jobs ───────────────────────────────────────────────────────────
      // The durable, observable queue for long runtime ops (prebuild bake,
      // toolset build/capture). POSTs to those endpoints answer `202` with a
      // `running` job; clients poll `GET /jobs/:id`, watch `GET /jobs`, or
      // subscribe to the `/jobs/events` SSE feed, and can `cancel`.
      .get("/jobs", ({ query }) => jobs.list(query.limit ?? 200), {
        query: t.Object({ limit: t.Optional(t.Number()) }),
      })
      .get("/jobs/:id", ({ params }) => jobs.get(params.id))
      .post("/jobs/:id/cancel", ({ params }) => jobs.cancel(params.id))
      .get("/jobs/events", async function* ({ request }) {
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
      })
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
        async ({ body, set }) => {
          const record =
            "seed" in body
              ? await container.images.buildSeed(body.seed, {
                  force: body.force,
                })
              : await container.images.buildDockerfile(
                  body.name,
                  body.dockerfile,
                );
          set.status = 202;
          return record;
        },
        {
          body: t.Union([
            t.Object({ seed: t.String(), force: t.Optional(t.Boolean()) }),
            t.Object({ name: t.String(), dockerfile: t.String() }),
          ]),
        },
      )
      .post(
        "/images/upload",
        async ({ body, set }) => {
          const zipPath = join(
            tmpdir(),
            `atelier-image-upload-${Date.now()}-${randomUUID()}.zip`,
          );
          await Bun.write(zipPath, body.file);
          let contextDir: string | undefined;
          try {
            contextDir = await unpackZipContext(zipPath);
            const dockerfile = await readContextDockerfile(contextDir);
            // On success the service takes ownership of `contextDir` (the
            // background build still needs it) and cleans it up when the
            // build settles — so DON'T delete it here.
            const record = await container.images.buildDockerfile(
              body.name,
              dockerfile,
              contextDir,
            );
            set.status = 202;
            return record;
          } catch (err) {
            // buildDockerfile threw before taking ownership (e.g. invalid
            // name) — the context is ours to clean.
            if (contextDir)
              await rm(contextDir, { recursive: true, force: true });
            throw err;
          } finally {
            await rm(zipPath, { force: true });
          }
        },
        {
          body: t.Object({ name: t.String(), file: t.File() }),
        },
      )
      .post(
        "/images/register",
        ({ body }) => container.images.registerExternal(body.name, body.ref),
        { body: t.Object({ name: t.String(), ref: t.String() }) },
      )
      .delete(
        "/images/:name",
        ({ params, set }) => {
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
          const spec = body as PrebuildSpec;
          // Transient credential for cloning private repos in the build pod;
          // scrubbed before the snapshot (never baked into the shared
          // content-addressed artifact). Resolved now (in request scope), not
          // inside the background job.
          const githubToken = control.userService.resolveGitHubToken(user.id);
          const job = jobs.dispatch(
            {
              kind: "prebuild",
              target: prebuildLabel(spec),
              metadata: spec.metadata,
            },
            (signal) =>
              runtime.prebuild(spec, {
                force: query.force === true,
                githubToken,
                signal,
              }),
          );
          set.status = 202;
          return job;
        },
        {
          body: PrebuildSpecSchema,
          query: t.Object({ force: t.Optional(t.Boolean()) }),
        },
      )
      .delete(
        "/prebuilds/:ref",
        async ({ params, set }) => {
          await runtime.deletePrebuild(params.ref);
          set.status = 204;
        },
        { params: t.Object({ ref: t.String() }) },
      )
      // ── toolsets ───────────────────────────────────────────────────────
      .get("/toolsets", () =>
        runtime.listToolsets().map((entry) => ({
          ...entry,
          harness: harnessForToolset(container, entry.name),
        })),
      )
      .post(
        "/toolsets",
        ({ body, set }) => {
          const req = body as ToolsetBuildRequest;
          const job = jobs.dispatch(
            {
              kind: "toolset-build",
              target: req.name,
              metadata: req.metadata,
            },
            (signal) => runtime.buildToolset(req, signal),
          );
          set.status = 202;
          return job;
        },
        { body: ToolsetBuildRequestSchema },
      )
      .post(
        "/toolsets/publish",
        async ({ body }) => runtime.publishToolset((body as ToolsetRef).ref),
        { body: ToolsetRefSchema },
      )
      .delete(
        "/toolsets",
        async ({ query, set }) => {
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
      // Lifecycle ops are `track`ed (not `dispatch`ed): recorded in the job
      // feed for visibility but AWAITED so the route still returns the
      // resource inline, and unpooled so a spawn never queues behind a build.
      .post(
        "/sandboxes",
        ({ body, user }) => {
          const req = body as CreateSandboxRequest;
          return jobs.track(
            { kind: "sandbox-create", target: sandboxLabel(req) },
            () => createSandboxForUser(container, user, req),
          );
        },
        { body: CreateSandboxRequestSchema },
      )
      .get("/sandboxes", () => runtime.list())
      .get("/sandboxes/:id", async ({ params }) => runtime.get(params.id))
      .post("/sandboxes/:id/pause", ({ params }) =>
        jobs.track({ kind: "sandbox-pause", target: params.id }, () =>
          runtime.pause(params.id),
        ),
      )
      .post(
        "/sandboxes/:id/resume",
        async ({ params, body }) => {
          // Refresh the owner's git credentials on resume (the credential
          // rotation primitive): re-resolve the owner from the persisted
          // owner-id metadata — stable regardless of who triggers the resume —
          // and merge fresh git files over the persisted (possibly stale) ones.
          const state = await runtime.get(params.id);
          const ownerId = state.metadata?.[OWNER_ID_METADATA];
          const ownerUser = ownerId
            ? control.userService.getById(ownerId)
            : undefined;
          const gitFiles = buildGitAttributionFiles({
            identity: ownerUser
              ? { name: ownerUser.username, email: ownerUser.email }
              : undefined,
            githubToken: control.userService.resolveGitHubToken(ownerId),
          });
          const merged = {
            ...body,
            files: [...(body.files ?? []), ...gitFiles],
          };
          return jobs.track({ kind: "sandbox-resume", target: params.id }, () =>
            runtime.resume(params.id, merged),
          );
        },
        { body: ResumeRequestSchema },
      )
      .delete("/sandboxes/:id", async ({ params, set }) => {
        await jobs.track({ kind: "sandbox-destroy", target: params.id }, () =>
          runtime.destroy(params.id),
        );
        set.status = 204;
      })
      // ── live mutations ────────────────────────────────────────────────
      .patch(
        "/sandboxes/:id/files",
        async ({ params, body, set }) => {
          await runtime.patchFiles(params.id, body);
          set.status = 204;
        },
        { body: PatchFilesRequestSchema },
      )
      .patch(
        "/sandboxes/:id/env",
        async ({ params, body, set }) => {
          await runtime.patchEnv(params.id, body);
          set.status = 204;
        },
        { body: PatchEnvRequestSchema },
      )
      .post(
        "/sandboxes/:id/processes",
        async ({ params, body, set }) => {
          await runtime.addProcess(params.id, body);
          set.status = 204;
        },
        { body: AddProcessRequestSchema },
      )
      .post(
        "/sandboxes/:id/processes/:name/:action",
        async ({ params, set }) => {
          if (params.action !== "start" && params.action !== "stop") {
            set.status = 501;
            return { error: `Unsupported process action "${params.action}"` };
          }
          await runtime.processAction(params.id, params.name, params.action);
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
      .get("/sandboxes/:id/processes/:name/logs", async ({ params }) =>
        runtime.processLogs(params.id, params.name),
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
        async ({ params, body }) => runtime.exec(params.id, body),
        { body: ExecRequestSchema },
      )
      .post("/sandboxes/:id/snapshot", ({ params }) =>
        jobs.track({ kind: "sandbox-snapshot", target: params.id }, () =>
          runtime.snapshot(params.id),
        ),
      )
      .post(
        "/sandboxes/:id/toolsets/capture",
        ({ params, body, set }) => {
          const req = body as ToolsetCaptureRequest;
          const job = jobs.dispatch(
            {
              kind: "toolset-capture",
              target: req.name,
              metadata: { sandboxId: params.id },
            },
            (signal) => runtime.captureToolset(params.id, req, signal),
          );
          set.status = 202;
          return job;
        },
        { body: ToolsetCaptureRequestSchema },
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
          if (!(ws.data as { user?: { id: string } }).user) {
            ws.close(4001, "Unauthorized");
            return;
          }
          const { id, name } = ws.data.params;
          // `ro` joins the read-only fan-out; `rw` (default) takes the single
          // writer slot. Pure passthrough — runtime.attach already models both.
          const mode = ws.data.query.mode ?? "rw";
          try {
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
          relayMessage(ws, message);
        },
        close(ws) {
          closeUpstream(ws);
        },
      })
  );
}
