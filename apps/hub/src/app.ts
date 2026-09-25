/**
 * The hub's HTTP surface: `/api/*` (REST, bearer auth), `/mcp` (the same
 * operations as MCP tools, for sandboxes and harnesses) and
 * `/webhooks/github` (HMAC-signed push events → re-index).
 */
import {
  type Direction,
  KnowledgeError,
  type MemoryFilter,
  type MemoryKind,
  type MemoryScopeKind,
  type MemoryStatus,
  NotFoundError,
  type SearchKind,
} from "@atelier/knowledge";
import { Elysia, t } from "elysia";
import { AuthError, type Caller, requireScope } from "./auth.ts";
import { triageDelivery, verifySignature } from "./github-webhook.ts";
import { createLogger } from "./logger.ts";
import { createMcpRoutes } from "./mcp.ts";
import * as ops from "./ops.ts";
import type { HubServices } from "./services.ts";

const log = createLogger("http");

const ERROR_STATUS: Record<KnowledgeError["code"], number> = {
  not_found: 404,
  forbidden: 403,
  invalid: 400,
  conflict: 409,
};

const list = (v: string | undefined): string[] | undefined =>
  v
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const ScopeBody = t.Object({
  kind: t.Union([
    t.Literal("org"),
    t.Literal("team"),
    t.Literal("repo"),
    t.Literal("channel"),
    t.Literal("user"),
  ]),
  id: t.Optional(t.String()),
});

const FactBody = t.Object({
  type: t.String(),
  from: t.String(),
  to: t.String(),
  attrs: t.Optional(t.Record(t.String(), t.Unknown())),
});

const ProvenanceBody = t.Object({
  kind: t.String(),
  ref: t.String(),
  url: t.Optional(t.String()),
  quote: t.Optional(t.String()),
});

const PatchBody = t.Object({
  content: t.Optional(t.String()),
  tags: t.Optional(t.Array(t.String())),
  readers: t.Optional(t.Array(t.String())),
  entityIds: t.Optional(t.Array(t.String())),
  facts: t.Optional(t.Array(FactBody)),
  scope: t.Optional(ScopeBody),
  kind: t.Optional(t.String()),
  validFrom: t.Optional(t.Number()),
  validTo: t.Optional(t.Union([t.Number(), t.Null()])),
});

type PatchInput = typeof PatchBody.static;

function toPatch(body: PatchInput) {
  return {
    ...body,
    kind: body.kind as MemoryKind | undefined,
    scope: body.scope && { kind: body.scope.kind, id: body.scope.id ?? "" },
  };
}

function memoryFilter(q: Record<string, string | undefined>): MemoryFilter {
  return {
    status: list(q.status) as MemoryStatus[] | undefined,
    kind: list(q.kind) as MemoryKind[] | undefined,
    tags: list(q.tags),
    entityId: q.entity,
    scope: q.scope_kind
      ? { kind: q.scope_kind as MemoryScopeKind, id: q.scope_id }
      : undefined,
    createdBefore: num(q.created_before),
    createdAfter: num(q.created_after),
    limit: num(q.limit),
    offset: num(q.offset),
  };
}

export function createHubApp(hub: HubServices) {
  const authed = new Elysia({ name: "hub-auth" }).derive(
    { as: "scoped" },
    ({ request }): { caller: Caller } => ({
      caller: hub.auth.authenticate(request.headers.get("authorization")),
    }),
  );

  const api = new Elysia({ prefix: "/api" })
    .use(authed)
    .get("/whoami", ({ caller }) => ({
      token: caller.token,
      actor: caller.actor,
      scopes: [...caller.scopes],
      audience: caller.audience,
    }))
    .get("/search", ({ caller, query }) =>
      ops.search(hub, caller, {
        query: query.q ?? "",
        kinds: list(query.kinds) as SearchKind[] | undefined,
        limit: num(query.limit),
        entityId: query.entity,
        audience: query.audience,
        includeStale: query.stale === "true",
      }),
    )

    // ── memories ──────────────────────────────────────────────────────
    .get("/memories", ({ caller, query }) => {
      const filter = memoryFilter(query);
      if (caller.scopes.has("review")) return hub.memory.list(filter);
      // Readers: active only, then the audience filter.
      requireScope(caller, "read");
      return hub.memory.list({ ...filter, status: ["active"] }).filter((m) => {
        try {
          ops.readMemory(hub, caller, m.id, query.audience);
          return true;
        } catch {
          return false;
        }
      });
    })
    .get("/memories/review-queue", ({ caller, query }) => {
      requireScope(caller, "review");
      return hub.memory.reviewQueue(num(query.limit) ?? 50);
    })
    .get("/memories/:id", ({ caller, params, query }) =>
      ops.readMemory(hub, caller, params.id, query.audience),
    )
    .post(
      "/memories",
      ({ caller, body, set }) => {
        set.status = 201;
        return ops.proposeMemory(hub, caller, {
          ...body,
          kind: body.kind as MemoryKind,
          scope: { kind: body.scope.kind, id: body.scope.id ?? "" },
          provenance: body.provenance as never,
        });
      },
      {
        body: t.Object({
          scope: ScopeBody,
          kind: t.String(),
          content: t.String(),
          tags: t.Optional(t.Array(t.String())),
          readers: t.Optional(t.Array(t.String())),
          entityIds: t.Optional(t.Array(t.String())),
          facts: t.Optional(t.Array(FactBody)),
          provenance: t.Optional(t.Array(ProvenanceBody)),
          validFrom: t.Optional(t.Number()),
          validTo: t.Optional(t.Number()),
          supersedes: t.Optional(t.String()),
        }),
      },
    )
    .patch(
      "/memories/:id",
      ({ caller, params, body }) => {
        requireScope(caller, "review");
        return hub.memory.edit(params.id, toPatch(body), caller.actor);
      },
      { body: PatchBody },
    )
    .post(
      "/memories/:id/approve",
      ({ caller, params, body }) => {
        requireScope(caller, "review");
        return hub.memory.approve(params.id, caller.actor, {
          note: body?.note,
          patch: body?.patch && toPatch(body.patch),
        });
      },
      {
        body: t.Optional(
          t.Object({
            note: t.Optional(t.String()),
            patch: t.Optional(PatchBody),
          }),
        ),
      },
    )
    .post(
      "/memories/:id/reject",
      ({ caller, params, body }) => {
        requireScope(caller, "review");
        return hub.memory.reject(params.id, caller.actor, body?.note);
      },
      { body: t.Optional(t.Object({ note: t.Optional(t.String()) })) },
    )
    .post(
      "/memories/:id/flag",
      ({ caller, params, body }) =>
        ops.flagMemory(hub, caller, params.id, body.reason),
      { body: t.Object({ reason: t.String() }) },
    )
    .post("/memories/:id/restore", ({ caller, params }) => {
      requireScope(caller, "review");
      return hub.memory.restore(params.id, caller.actor);
    })
    .post(
      "/memories/:id/archive",
      ({ caller, params, body }) => {
        requireScope(caller, "review");
        return hub.memory.archive(params.id, caller.actor, body?.reason);
      },
      { body: t.Optional(t.Object({ reason: t.Optional(t.String()) })) },
    )
    .post(
      "/memories/archive",
      ({ caller, body }) => {
        requireScope(caller, "review");
        const archived = hub.memory.archiveWhere(
          memoryFilter(body.filter),
          caller.actor,
          body.reason,
        );
        return { archived };
      },
      {
        body: t.Object({
          reason: t.String(),
          filter: t.Record(t.String(), t.String()),
        }),
      },
    )
    .post(
      "/memories/erase",
      async ({ caller, body }) => {
        requireScope(caller, "review");
        return hub.memory.erase(body.ids, caller.actor, body.reason);
      },
      {
        body: t.Object({
          ids: t.Array(t.String(), { minItems: 1 }),
          reason: t.Optional(t.String()),
        }),
      },
    )
    .get("/audit", ({ caller, query }) => {
      requireScope(caller, "review");
      return hub.audit.list({
        target: query.target_id
          ? {
              kind: (query.target_kind ?? "memory") as "memory",
              id: query.target_id,
            }
          : undefined,
        since: num(query.since),
        limit: num(query.limit),
      });
    })

    // ── graph ─────────────────────────────────────────────────────────
    .get("/graph/entities", ({ caller, query }) => {
      requireScope(caller, "read");
      return hub.graph.listEntities({
        audience: caller.audience,
        type: query.type,
        includeRetired: query.retired === "true",
        limit: num(query.limit),
        offset: num(query.offset),
      });
    })
    .get("/graph/entities/:id", ({ caller, params, query }) =>
      ops.readEntity(hub, caller, decodeURIComponent(params.id), {
        audience: query.audience,
        asOf: num(query.as_of),
        history: query.history === "true",
      }),
    )
    .get("/graph/neighbors", ({ caller, query }) => {
      if (!query.id) throw new NotFoundError("entity", "");
      return ops.neighbors(hub, caller, {
        id: query.id,
        depth: num(query.depth),
        direction: query.direction as Direction | undefined,
        types: list(query.types),
        asOf: num(query.as_of),
        limit: num(query.limit),
        audience: query.audience,
      });
    })

    // ── documents & indexing ──────────────────────────────────────────
    .get("/documents/collections", ({ caller }) => {
      requireScope(caller, "read");
      return hub.documents.collections();
    })
    .get("/index/repos", ({ caller }) => {
      requireScope(caller, "read");
      return hub.config.repos.map((r) => ({
        repo: r.repo,
        branch: r.branch,
        running: hub.indexer.isRunning(r.repo),
        last: hub.indexer.runs({ repo: r.repo, limit: 1 })[0],
      }));
    })
    .get("/index/runs", ({ caller, query }) => {
      requireScope(caller, "read");
      return hub.indexer.runs({ repo: query.repo, limit: num(query.limit) });
    })
    .post("/index/repos/:owner/:name", ({ caller, params, query, set }) => {
      requireScope(caller, "index");
      const name = `${params.owner}/${params.name}`;
      const repo = hub.config.repos.find((r) => r.repo === name);
      if (!repo) throw new NotFoundError("tracked repo", name);
      const run = hub.indexer.trigger(
        repo,
        `manual:${caller.actor.id}`,
        query.force === "true",
      );
      if (query.wait === "true") return run;
      set.status = 202;
      return { queued: true, repo: name };
    });

  const webhooks = new Elysia().post(
    "/webhooks/github",
    async ({ request, set }) => {
      const secret = hub.config.secrets.webhookSecret;
      if (!secret) {
        set.status = 404;
        return { error: "webhooks disabled" };
      }
      const body = await request.text();
      const signature = request.headers.get("x-hub-signature-256");
      if (!verifySignature(secret, body, signature)) {
        set.status = 401;
        return { error: "bad signature" };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        set.status = 400;
        return { error: "invalid JSON" };
      }
      const decision = triageDelivery(
        request.headers.get("x-github-event"),
        payload,
        hub.config.repos,
      );
      if (decision.action === "ignore") return decision;
      void hub.indexer.trigger(
        decision.repo,
        `push:${decision.revision ?? "?"}`,
      );
      set.status = 202;
      return { action: "index", repo: decision.repo.repo };
    },
    { parse: "none" },
  );

  return new Elysia()
    .onError(({ error, set, code }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { error: error.message };
      }
      if (error instanceof KnowledgeError) {
        set.status = ERROR_STATUS[error.code];
        return { error: error.code, message: error.message };
      }
      if (code === "VALIDATION" || code === "PARSE") {
        set.status = 400;
        return { error: "invalid", message: String(error) };
      }
      if (code === "NOT_FOUND") {
        set.status = 404;
        return { error: "not_found" };
      }
      log.error({ error }, "unhandled error");
      set.status = 500;
      return { error: "internal" };
    })
    .get("/health", () => ({ ok: true }))
    .use(api)
    .use(webhooks)
    .use(createMcpRoutes(hub));
}

export type HubApp = ReturnType<typeof createHubApp>;
