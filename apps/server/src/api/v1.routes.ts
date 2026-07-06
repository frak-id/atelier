/**
 * `/v1/*` — the whole runtime API (atelier-v2 §2 "Runtime API (the whole
 * thing)"). Every route: authenticate (control) → enrich the spec (control's
 * two seam mutations) → call `runtime.*(spec)` once. The runtime itself never
 * sees an unresolved secret or an unauthenticated caller.
 */
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
import { Elysia, t } from "elysia";
import { createAuthPlugin } from "./auth.plugin.ts";
import {
  harnessForToolset,
  resolveSelectedToolboxes,
  resolveToolboxHarness,
  resolveToolboxRefs,
  resolveToolboxSurface,
  type ServerContainer,
} from "./container.ts";

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

export function createV1Routes(container: ServerContainer) {
  const { runtime, control } = container;
  const authPlugin = createAuthPlugin(control);

  return (
    new Elysia({ prefix: "/v1" })
      .use(authPlugin)
      // ── prebuilds ──────────────────────────────────────────────────────
      .get("/prebuilds", () => runtime.listPrebuilds())
      .post(
        "/prebuilds",
        async ({ body }) => runtime.prebuild(body as PrebuildSpec),
        { body: PrebuildSpecSchema },
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
        async ({ body }) => runtime.buildToolset(body as ToolsetBuildRequest),
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
          runtime.deleteToolset((query as ToolsetRef).ref);
          set.status = 204;
        },
        { query: ToolsetRefSchema },
      )
      // ── sandboxes ──────────────────────────────────────────────────────
      .post(
        "/sandboxes",
        async ({ body, user }) => {
          // The body is a spec plus the high-level `toolboxes` the caller
          // picked; strip the selectors so the runtime only ever sees a spec.
          const { toolboxes: selectors = [], ...specFields } =
            body as CreateSandboxRequest;
          const spec = specFields as SandboxSpec;
          const orgId = resolveOrgId(control, user.id);
          const authorizedKeys = control.sshKeyService.getValidPublicKeys();
          // Auto-inject org (baseline) then user (personal overlay) toolboxes,
          // oldest-first (R6), then the explicitly-picked ones.
          const autoInjectRefs = await resolveToolboxRefs(container, {
            orgId,
            userId: user.id,
          });
          const selectedRefs = await resolveSelectedToolboxes(
            container,
            selectors,
          );
          // Every toolbox applied to this spawn, as parseable `tb/…` handles —
          // auto-injected refs, picked selectors (incl. process-only ones with
          // no toolset), and any explicit `spec.toolsets`. Drives harness +
          // surface resolution.
          const applied = [
            ...autoInjectRefs,
            ...selectors.map((ref) => ({ ref })),
            ...(spec.toolsets ?? []),
          ];
          // Harness precedence: spec > toolbox > org policy.
          const toolboxHarnessId = resolveToolboxHarness(container, applied);
          const enriched = await control.enrichSpec(spec, orgId, {
            toolboxHarnessId,
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
          // Merge the processes + ports every applied toolbox contributes
          // (its tool's running surface), keyed by name (spec's own win).
          const surface = resolveToolboxSurface(container, applied);
          const withToolboxes: SandboxSpec = {
            ...enriched,
            toolsets,
            processes: mergeByName(surface.processes, enriched.processes),
            ports: mergeByName(surface.ports, enriched.ports),
          };
          return runtime.create(withToolboxes, { authorizedKeys });
        },
        { body: CreateSandboxRequestSchema },
      )
      .get("/sandboxes", () => runtime.list())
      .get("/sandboxes/:id", async ({ params }) => runtime.get(params.id))
      .post("/sandboxes/:id/pause", async ({ params }) =>
        runtime.pause(params.id),
      )
      .post(
        "/sandboxes/:id/resume",
        async ({ params, body }) => runtime.resume(params.id, body),
        { body: ResumeRequestSchema },
      )
      .delete("/sandboxes/:id", async ({ params, set }) => {
        await runtime.destroy(params.id);
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
      .post("/sandboxes/:id/snapshot", async ({ params }) =>
        runtime.snapshot(params.id),
      )
      .post(
        "/sandboxes/:id/toolsets/capture",
        async ({ params, body }) =>
          runtime.captureToolset(params.id, body as ToolsetCaptureRequest),
        { body: ToolsetCaptureRequestSchema },
      )
      // ── attach ─────────────────────────────────────────────────────────
      .ws("/sandboxes/:id/attach/:name", {
        query: t.Object({
          mode: t.Optional(t.Union([t.Literal("rw"), t.Literal("ro")])),
        }),
        async open(ws) {
          const { id, name } = ws.data.params;
          // `ro` joins the read-only fan-out; `rw` (default) takes the single
          // writer slot. Pure passthrough — runtime.attach already models both.
          const mode = ws.data.query.mode ?? "rw";
          try {
            const { url } = await runtime.attach(id, name, mode);
            const upstream = new WebSocket(url);
            upstream.binaryType = "arraybuffer";
            upstream.onmessage = (event) => {
              const data = event.data;
              if (data instanceof ArrayBuffer) ws.send(Buffer.from(data));
              else if (typeof data === "string") ws.send(data);
            };
            upstream.onclose = () => ws.close();
            upstream.onerror = () => ws.close(1011, "Upstream error");
            (ws.data as Record<string, unknown>).upstream = upstream;
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
          const upstream = (ws.data as Record<string, unknown>).upstream as
            | WebSocket
            | undefined;
          if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
          if (typeof message === "string") upstream.send(message);
          else if (message instanceof Uint8Array)
            upstream.send(message as Uint8Array<ArrayBuffer>);
        },
        close(ws) {
          const upstream = (ws.data as Record<string, unknown>).upstream as
            | WebSocket
            | undefined;
          if (upstream?.readyState === WebSocket.OPEN) upstream.close();
        },
      })
  );
}
