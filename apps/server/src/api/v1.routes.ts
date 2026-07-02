/**
 * `/v1/*` — the whole runtime API (atelier-v2 §2 "Runtime API (the whole
 * thing)"). Every route: authenticate (control) → enrich the spec (control's
 * two seam mutations) → call `runtime.*(spec)` once. The runtime itself never
 * sees an unresolved secret or an unauthenticated caller.
 */
import {
  AddPortRequestSchema,
  AddProcessRequestSchema,
  type CatalogAddRequest,
  CatalogAddRequestSchema,
  ExecRequestSchema,
  PatchEnvRequestSchema,
  PatchFilesRequestSchema,
  type PrebuildSpec,
  PrebuildSpecSchema,
  ResumeRequestSchema,
  type SandboxSpec,
  SandboxSpecSchema,
} from "@atelier/spec";
import { Elysia, t } from "elysia";
import { createAuthPlugin } from "./auth.plugin.ts";
import type { ServerContainer } from "./container.ts";

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
      .post(
        "/prebuilds",
        async ({ body }) => runtime.prebuild(body as PrebuildSpec),
        { body: PrebuildSpecSchema },
      )
      // ── catalog ────────────────────────────────────────────────────────
      .get("/catalog", () => runtime.catalogList())
      .post(
        "/catalog",
        async ({ body }) => runtime.catalogAdd(body as CatalogAddRequest),
        { body: CatalogAddRequestSchema },
      )
      // ── sandboxes ──────────────────────────────────────────────────────
      .post(
        "/sandboxes",
        async ({ body, user }) => {
          const orgId = resolveOrgId(control, user.id);
          const enriched = await control.enrichSpec(body as SandboxSpec, orgId);
          const authorizedKeys = control.sshKeyService.getValidPublicKeys();
          return runtime.create(enriched, { authorizedKeys });
        },
        { body: SandboxSpecSchema },
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
      // ── attach ─────────────────────────────────────────────────────────
      .ws("/sandboxes/:id/attach/:name", {
        async open(ws) {
          const { id, name } = ws.data.params;
          try {
            const { url } = await runtime.attach(id, name);
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
          const upstream = (ws.data as Record<string, unknown>).upstream as
            | WebSocket
            | undefined;
          if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
          if (typeof message === "string") upstream.send(message);
          else if (message instanceof Uint8Array) upstream.send(message);
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
