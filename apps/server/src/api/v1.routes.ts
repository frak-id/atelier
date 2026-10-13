/**
 * `/v1/*` — the whole runtime API (design.md §2 "Runtime API (the whole
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
  buildRepoPrebuildSpec,
  type CreateSandboxRequest,
  CreateSandboxRequestSchema,
  ExecRequestSchema,
  type ForkSandboxRequest,
  ForkSandboxRequestSchema,
  findRepoBranchPrebuild,
  PatchEnvRequestSchema,
  PatchFilesRequestSchema,
  type PrebuildSpec,
  PrebuildSpecSchema,
  prebuildJobTarget,
  type ResumeRequest,
  ResumeRequestSchema,
  runtimeSurfaceOf,
  SANDBOX_NAME_ANNOTATION,
  SANDBOX_ORG_ANNOTATION,
  type SandboxSpec,
  SurfacePortsSchema,
  SurfaceProcessesSchema,
  type ToolsetBuildRequest,
  ToolsetBuildRequestSchema,
  type ToolsetCaptureRequest,
  ToolsetCaptureRequestSchema,
  type ToolsetRef,
  ToolsetRefSchema,
  UpdateSandboxRequestSchema,
} from "@atelier/spec";
import { Elysia, sse, t } from "elysia";
import {
  type JobRecord,
  readContextDockerfile,
  unpackZipContext,
} from "../runtime/index.ts";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../shared/errors.ts";
import {
  buildGitAttributionFiles,
  OWNER_ID_METADATA,
} from "../shared/lib/git-attribution.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import {
  defaultMemoryMb,
  defaultVcpus,
  imageBuilderConfig,
} from "../shared/lib/runtime-config.ts";
import { createAuthPlugin } from "./auth.plugin.ts";
import {
  harnessForToolset,
  resolveSelectedToolboxes,
  resolveToolboxHarness,
  resolveToolboxRefs,
  resolveToolboxSurface,
  type ServerContainer,
} from "./container.ts";
import {
  accessibleSandboxes,
  requireSandboxAccess,
  requireSourceAccess,
  sandboxAccessGuard,
} from "./sandbox-guard.ts";
import { spawnSurface } from "./spawn-surface.ts";
import { closeUpstream, openUpstreamRelay, relayMessage } from "./ws-relay.ts";

const log = createChildLogger("v1-routes");

/**
 * H7: the active cluster-native builder (kaniko/buildkit) packages the whole
 * build context as a single base64'd ConfigMap and refuses anything whose
 * encoded size nears the Kubernetes API server's ~1MiB object cap — see
 * `MAX_CONTEXT_BYTES` in `../runtime/registry/builder/k8s-build-job.ts`
 * (kept in sync here; not re-exported through the runtime barrel, so this is
 * a duplicated literal, not an import — see that file for the source of
 * truth). `zip-context.ts`'s 100MB cap is for the docker backend; a BYO/zip
 * context over this much smaller ceiling would previously be accepted
 * (`202`) and only fail asynchronously mid-build. Reject it synchronously at
 * accept time instead when kaniko/buildkit is the active builder.
 */
const MAX_K8S_NATIVE_CONTEXT_BYTES = 900_000;

/** Rough base64-inflated size estimate for a raw (pre-tar) context, used to
 * fail fast before even unpacking/tarring — tar + base64 only ever grows the
 * byte count (tar adds block-alignment padding, base64 adds ~33%), so an
 * input already over the ceiling can be rejected immediately. */
function exceedsK8sNativeContextCeiling(rawBytes: number): boolean {
  return rawBytes > MAX_K8S_NATIVE_CONTEXT_BYTES;
}

/**
 * S3: `/v1/images*` accepts an arbitrary Dockerfile and (with the default
 * `imageBuilder.kind=docker`) runs it as a root-equivalent build against the
 * host's docker daemon — gate build/upload/register/delete behind an
 * elevated role. There is genuinely no server-wide admin/operator role today
 * (see `control.routes.ts`'s `configRoutes` comment: "no server-admin role
 * yet"). This reuses control's existing org-scoped RBAC primitive
 * (`OrgMemberService.requireRole`, `OrgMemberRole = owner|admin|member|
 * viewer`) as the smallest correct proxy: the caller must be `owner` or
 * `admin` of at least one organization they belong to. Revisit once a real
 * server-wide admin role exists — this is an explicit assumption, not a new
 * permissions system.
 */
function requireImageOperator(
  control: ServerContainer["control"],
  userId: string,
): void {
  const isOperator = control.orgMemberService
    .getByUserId(userId)
    .some((m) => m.role === "owner" || m.role === "admin");
  if (!isOperator) {
    throw new ForbiddenError(
      "Building or managing images requires an owner/admin role in at " +
        "least one organization.",
    );
  }
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

/** `repo` is sugar over `prebuild` with an image base: both at once, or a
 * snapshot source, leave no unambiguous recipe (400). */
function assertRepoRequest(req: CreateSandboxRequest): void {
  if (!req.repo) return;
  if (req.prebuild) {
    throw new ValidationError("`repo` cannot be combined with `prebuild`");
  }
  if (!("image" in req.source)) {
    throw new ValidationError(
      "`repo` needs an image `source` (the base the repo is baked on)",
    );
  }
}

/** Parse `GET /v1/sandboxes?metadata=`: a JSON object of string → string
 * (already URL-decoded). Absent is no filter; anything else is a 400. */
export function parseMetadataFilter(raw?: string): Record<string, string> {
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

/** A copy of `record` without `key` (undefined stays undefined). */
function withoutKey(
  record: Record<string, string> | undefined,
  key: string,
): Record<string, string> | undefined {
  if (!record) return record;
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

/** `GET /v1/sandboxes?owner=`: `me` is the caller. */
function ownerFilter(owner: string | undefined, userId: string) {
  return owner === "me" ? userId : owner;
}

/**
 * The org a spawn runs in (whose secrets, policy and auto-injected toolboxes
 * it gets). An explicit `requested` org must be one the caller belongs to.
 * Absent, it's the caller's personal org, else their oldest membership, else
 * none (spawn bare — an org-less user still gets their own toolboxes).
 */
export function resolveOrgId(
  control: ServerContainer["control"],
  userId: string,
  requested?: string,
): string | undefined {
  if (requested) {
    control.orgMemberService.requireMembership(requested, userId);
    return requested;
  }
  const memberships = control.orgMemberService.getByUserId(userId);
  const personal = control.userService.getById(userId)?.personalOrgId;
  if (personal && memberships.some((m) => m.orgId === personal)) {
    return personal;
  }
  return [...memberships].sort((a, b) =>
    a.joinedAt.localeCompare(b.joinedAt),
  )[0]?.orgId;
}

/**
 * Shared by `POST /v1/sandboxes` and the `create_sandbox` MCP tool (the
 * "one API, three surfaces" principle, design.md §4): resolve the caller's
 * org, apply toolbox auto-inject + explicit selectors, run the enrichment
 * seam, merge toolbox-contributed processes/ports, and boot. Both callers
 * pass an authenticated `AuthUser` — there is exactly one enrichment path.
 */
export async function createSandboxForUser(
  container: ServerContainer,
  user: { id: string; username: string; email: string },
  body: CreateSandboxRequest,
  id?: string,
  onProgress?: (msg: string) => void,
) {
  const { runtime, control } = container;
  assertRepoRequest(body);
  // The body is a spec plus the high-level references the caller picked
  // (`toolboxes` selectors, a `prebuild` recipe, a `repo`); strip them so the
  // runtime only ever sees a resolved spec.
  const {
    toolboxes: selectors = [],
    prebuild: bodyPrebuild,
    repo,
    orgId: requestedOrgId,
    resources,
    metadata,
    annotations,
    ...specFields
  } = body;
  // A sandbox-scoped snapshot is its sandbox's data (access rule).
  requireSourceAccess(container, user.id, body.source, body.prebuild?.source);
  // Resolved first: an unauthorized org must fail before any build work.
  const orgId = resolveOrgId(control, user.id, requestedOrgId);
  // `resources` is optional on the request (each field too): fill the gaps
  // from the server's defaults so the runtime always sees a complete spec.
  // The owner-id metadata and the org annotation are server-owned (access
  // rule): enrichment sets the owner and the resolved org is applied below,
  // so a caller-supplied value never survives.
  const callerMetadata = withoutKey(metadata, OWNER_ID_METADATA);
  const callerAnnotations = withoutKey(annotations, SANDBOX_ORG_ANNOTATION);
  let spec: SandboxSpec = {
    ...specFields,
    ...(callerMetadata ? { metadata: callerMetadata } : {}),
    ...(callerAnnotations ? { annotations: callerAnnotations } : {}),
    resources: {
      ...resources,
      vcpus: resources?.vcpus ?? defaultVcpus(),
      memoryMb: resources?.memoryMb ?? defaultMemoryMb(),
    },
  };
  // `repo`: boot from an existing bake of it, else bake a quick one-repo
  // prebuild below (on `source.image`, the base `assertRepoRequest` checked).
  let prebuild = bodyPrebuild;
  if (repo && "image" in spec.source) {
    // Only a bake on the requested base image: another base is another
    // environment.
    const baseImage = spec.source.image;
    const baked = findRepoBranchPrebuild(
      runtime
        .listPrebuilds()
        .filter(
          (record) =>
            record.spec?.source !== undefined &&
            "image" in record.spec.source &&
            record.spec.source.image === baseImage,
        ),
      repo.url,
      repo.branch,
    );
    if (baked) {
      spec = { ...spec, source: { snapshot: baked.ref } };
    } else {
      prebuild = buildRepoPrebuildSpec({
        repo: repo.url,
        branch: repo.branch,
        image: spec.source.image,
      });
    }
  }
  // A template built from a prebuild carries the recipe, not a pinned ref:
  // resolve it to the current snapshot (idempotent — a cache hit when
  // unchanged) so an updated prebuild is picked up here.
  if (prebuild) {
    onProgress?.("resolving prebuild…");
    const snapshot = await runtime.prebuild(prebuild, {
      githubToken: control.userService.resolveGitHubToken(user.id),
    });
    spec = { ...spec, source: { snapshot: snapshot.ref } };
  }
  if (selectors.length > 0) onProgress?.("resolving toolboxes…");
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
  // The runtime surface: the prebuild's dev servers, then the toolboxes'
  // tools, then the spec's own (see `spawnSurface` for who wins). A recipe
  // that declares dev servers brings its own (a Launchpad custom boot);
  // otherwise they're the stored recipe's current ones, so a copied recipe
  // (a starter following a prebuild) or a pinned snapshot never misses
  // dev servers edited since.
  const declared = prebuild ? runtimeSurfaceOf(prebuild) : {};
  const surface = spawnSurface({
    prebuild:
      declared.processes || declared.ports
        ? declared
        : "snapshot" in spec.source
          ? runtime.prebuildSurface(spec.source.snapshot)
          : undefined,
    toolboxes: resolveToolboxSurface(container, applied),
    own: enriched,
  });
  if (surface.shadowed.length > 0) {
    log.warn(
      { id, shadowed: surface.shadowed },
      "toolbox entries replace same-name prebuild processes/ports",
    );
  }
  const withToolboxes: SandboxSpec = {
    ...enriched,
    toolsets,
    processes: surface.processes,
    ports: surface.ports,
    ...(orgId
      ? {
          annotations: {
            ...enriched.annotations,
            [SANDBOX_ORG_ANNOTATION]: orgId,
          },
        }
      : {}),
  };
  // Keys of the people who may reach it (its owner, its org's members).
  const authorizedKeys = control.sandboxSshKeys(withToolboxes);
  return runtime.create(withToolboxes, { authorizedKeys, id, onProgress });
}

/**
 * Shared by `POST /v1/sandboxes/:id/fork` and the `sandbox_lifecycle` MCP
 * tool's `fork` action: snapshot the source and boot a copy owned by the
 * CALLER. The runtime only does the mechanism; the copy's spec is derived here
 * through control — the source owner's git identity/credentials and owner
 * annotations are replaced by the caller's, and `metadata` is the body's with
 * `atelier.dev/owner-id` forced to the caller (an echoed value is overridden).
 * The copy keeps the source's org annotation (same org, same org secrets —
 * values resolved at the source's creation carry over). Authorizing access to
 * the source is the caller's job (the sandbox-access guard).
 *
 * Must reach `runtime.fork` without awaiting: the unpooled job relies on it
 * to register the copy's `creating` record before the route answers.
 */
export function forkSandboxForUser(
  container: ServerContainer,
  user: { id: string; username: string; email: string },
  sourceId: string,
  body: ForkSandboxRequest,
  id?: string,
  onProgress?: (msg: string) => void,
) {
  const { runtime, control } = container;
  const owner = {
    id: user.id,
    username: user.username,
    email: user.email,
    githubToken: control.userService.resolveGitHubToken(user.id),
  };
  const name = body.name?.trim() || undefined;
  // The copy's labels until `derive` runs (or if it fails): the caller as
  // owner, the source's org only, never the source owner's.
  const org = runtime.getLabels(sourceId)?.annotations[SANDBOX_ORG_ANNOTATION];
  return runtime.fork(
    sourceId,
    {
      name,
      initial: {
        metadata: { [OWNER_ID_METADATA]: user.id },
        annotations: {
          ...(org ? { [SANDBOX_ORG_ANNOTATION]: org } : {}),
          ...(name ? { [SANDBOX_NAME_ANNOTATION]: name } : {}),
        },
      },
      derive: (sourceSpec) => {
        const spec = control.reattributeSpec(sourceSpec, owner, body.metadata);
        return { spec, authorizedKeys: control.sandboxSshKeys(spec) };
      },
    },
    { id, onProgress },
  );
}

/**
 * A resume body with the owner's git credentials refreshed (the
 * credential-rotation primitive). The owner is re-resolved from the persisted
 * owner-id metadata, so it's stable regardless of who triggers the resume,
 * and fresh git files are merged over the persisted (possibly stale) ones.
 * Shared by `POST /v1/sandboxes/:id/resume` and the Launchpad wake-up.
 * Throws `NotFoundError` for an unknown sandbox.
 */
export async function withFreshCredentials(
  container: ServerContainer,
  id: string,
  body: ResumeRequest = {},
): Promise<ResumeRequest> {
  const { runtime, control } = container;
  const state = await runtime.get(id);
  const ownerId = state.metadata?.[OWNER_ID_METADATA];
  const ownerUser = ownerId ? control.userService.getById(ownerId) : undefined;
  const gitFiles = buildGitAttributionFiles({
    identity: ownerUser
      ? { name: ownerUser.username, email: ownerUser.email }
      : undefined,
    githubToken: control.userService.resolveGitHubToken(ownerId),
  });
  return { ...body, files: [...(body.files ?? []), ...gitFiles] };
}

export function createV1Routes(container: ServerContainer) {
  const { runtime, control, jobs } = container;
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
          requireImageOperator(control, user.id);
          // H7: a plain-dockerfile build's context is just the Dockerfile
          // text itself — still worth bounding against the k8s-native
          // ceiling up front when that's the active builder, for the same
          // reason as the zip-upload path below.
          if (
            (imageBuilderConfig().kind === "kaniko" ||
              imageBuilderConfig().kind === "buildkit") &&
            "dockerfile" in body &&
            exceedsK8sNativeContextCeiling(Buffer.byteLength(body.dockerfile))
          ) {
            throw new ValidationError(
              `Dockerfile (${Buffer.byteLength(body.dockerfile)} bytes) ` +
                `exceeds the ${MAX_K8S_NATIVE_CONTEXT_BYTES} byte ceiling ` +
                `of the active kaniko/buildkit builder.`,
            );
          }
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
        async ({ body, user, set }) => {
          requireImageOperator(control, user.id);
          // H7: reject a BYO/zip context over the active k8s-native builder's
          // real ceiling synchronously, at accept time — before this would
          // otherwise answer `202` and only fail once `stageContextTarball`
          // discovers it mid-build.
          if (
            (imageBuilderConfig().kind === "kaniko" ||
              imageBuilderConfig().kind === "buildkit") &&
            exceedsK8sNativeContextCeiling(body.file.size)
          ) {
            throw new ValidationError(
              `Uploaded context (${body.file.size} bytes) exceeds the ` +
                `${MAX_K8S_NATIVE_CONTEXT_BYTES} byte ceiling of the active ` +
                `kaniko/buildkit builder. Slim the context or use the docker ` +
                `builder for large uploads.`,
            );
          }
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
          // S1: bound the raw multipart body itself, not just the unpacked
          // context — a generous margin over the 100MB unpacked cap (zip
          // overhead, non-compressible content) while still refusing an
          // unbounded upload.
          body: t.Object({
            name: t.String(),
            file: t.File({ maxSize: "150m" }),
          }),
        },
      )
      .post(
        "/images/register",
        ({ body, user }) => {
          requireImageOperator(control, user.id);
          return container.images.registerExternal(body.name, body.ref);
        },
        { body: t.Object({ name: t.String(), ref: t.String() }) },
      )
      .delete(
        "/images/:name",
        ({ params, user, set }) => {
          requireImageOperator(control, user.id);
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
          // Chained on another sandbox's snapshot? Same rule as a spawn.
          requireSourceAccess(container, user.id, spec.source);
          // Transient credential for cloning private repos in the build pod;
          // scrubbed before the snapshot (never baked into the shared
          // content-addressed artifact). Resolved now (in request scope), not
          // inside the background job.
          const githubToken = control.userService.resolveGitHubToken(user.id);
          const job = jobs.dispatch(
            {
              kind: "prebuild",
              target: prebuildJobTarget(spec),
              metadata: spec.metadata,
            },
            (signal, log) =>
              runtime.prebuild(spec, {
                force: query.force === true,
                githubToken,
                signal,
                onLog: log,
                // The explicit create: a declared surface is saved on a
                // cache hit (a spawn's re-resolve never writes it).
                saveSurface: true,
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
      // create is `dispatch`ed (non-blocking, 202 + job); the other lifecycle
      // ops below (pause/resume/snapshot/destroy) are `track`ed — AWAITED so
      // the route returns the resource inline, unpooled so they never queue
      // behind a build.
      .post(
        "/sandboxes",
        ({ body, user, set }) => {
          const req = body as CreateSandboxRequest;
          // Checked here for a synchronous 400 (the create job re-checks for
          // MCP).
          assertRepoRequest(req);
          // Fail an org the caller can't use now (403), not in the job.
          resolveOrgId(control, user.id, req.orgId);
          // Same for a snapshot the caller may not boot from.
          requireSourceAccess(
            container,
            user.id,
            req.source,
            req.prebuild?.source,
          );
          // Non-blocking spawn: pre-allocate the id so the `202` job carries
          // `metadata.sandboxId` — the console navigates straight to the detail
          // page and shows its loading state (the `creating` record lands a
          // moment later, once source resolution completes; the detail query
          // retries the brief 404) instead of holding the button locked for the
          // whole multi-minute boot. Unpooled so a spawn never waits behind a
          // build.
          const id = safeNanoid();
          const job = jobs.dispatch(
            {
              kind: "sandbox-create",
              target: sandboxLabel(req),
              metadata: { sandboxId: id },
              unpooled: true,
            },
            (_signal, log) =>
              createSandboxForUser(container, user, req, id, log),
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
          return accessibleSandboxes(container, user.id, runtime.list(filter));
        },
        {
          query: t.Object({
            metadata: t.Optional(t.String()),
            owner: t.Optional(t.String()),
          }),
        },
      )
      .get("/sandboxes/:id", async ({ params }) => runtime.get(params.id))
      // Display-only edits (today: the name). A blank or `null` name clears
      // it; the console then falls back to the id.
      .patch(
        "/sandboxes/:id",
        ({ params, body, set }) => {
          if (body.name !== undefined) {
            const name = body.name?.trim() || undefined;
            runtime.setAnnotation(params.id, SANDBOX_NAME_ANNOTATION, name);
          }
          set.status = 204;
        },
        { body: UpdateSandboxRequestSchema },
      )
      .post("/sandboxes/:id/pause", ({ params }) =>
        jobs.track({ kind: "sandbox-pause", target: params.id }, () =>
          runtime.pause(params.id),
        ),
      )
      .post(
        "/sandboxes/:id/resume",
        async ({ params, body }) => {
          // Resolved before the job opens: an unknown id is a plain 404.
          const merged = await withFreshCredentials(container, params.id, body);
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
      .get(
        "/sandboxes/:id/processes/:name/logs",
        async ({ params, query }) =>
          runtime.processLogs(
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
        async ({ params, body }) => runtime.exec(params.id, body),
        { body: ExecRequestSchema },
      )
      .post("/sandboxes/:id/snapshot", ({ params }) =>
        jobs.track({ kind: "sandbox-snapshot", target: params.id }, () =>
          runtime.snapshot(params.id),
        ),
      )
      // Fork is a spawn: `202` with a `sandbox-create` job whose
      // `metadata.sandboxId` is the copy's pre-allocated id, exactly like
      // `POST /sandboxes`. The job snapshots the source, then boots the copy.
      .post(
        "/sandboxes/:id/fork",
        ({ params, body, user, set }) => {
          // No id is handed out that never gets a record: an unknown (404) or
          // non-snapshottable (409) source is a plain error, not a failed job.
          runtime.assertSnapshottable(params.id);
          // Unpooled dispatch runs the body synchronously up to its first
          // await, and the runtime registers the copy's `creating` record
          // before that: the id in this 202 resolves immediately.
          const id = safeNanoid();
          const job = jobs.dispatch(
            {
              kind: "sandbox-create",
              target: body.name ?? `fork of ${params.id}`,
              metadata: { sandboxId: id, forkOf: params.id },
              unpooled: true,
            },
            (_signal, log) =>
              forkSandboxForUser(container, user, params.id, body, id, log),
          );
          set.status = 202;
          return job;
        },
        { body: ForkSandboxRequestSchema },
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
            (signal, log) =>
              runtime.captureToolset(params.id, req, signal, log),
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
          relayMessage(ws, message);
        },
        close(ws) {
          closeUpstream(ws);
        },
      })
  );
}
