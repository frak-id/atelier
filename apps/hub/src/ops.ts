/**
 * Every read and write goes through here, whether it came from REST or MCP,
 * so scope checks, audience resolution and use-tracking can't drift between
 * the two surfaces.
 */
import {
  type Direction,
  type Entity,
  type Fact,
  isVisible,
  type Memory,
  type MemoryStatus,
  NotFoundError,
  type ProposeMemoryInput,
  type SearchHit,
  type SearchKind,
  type Subgraph,
} from "@atelier/knowledge";
import { type Caller, requireScope, resolveAudience } from "./auth.ts";
import type { HubServices } from "./services.ts";

export interface SearchParams {
  query: string;
  kinds?: SearchKind[];
  limit?: number;
  entityId?: string;
  audience?: string[] | string;
  /** Reviewers may also search stale/proposed memories. */
  includeStale?: boolean;
}

export async function search(
  hub: HubServices,
  caller: Caller,
  params: SearchParams,
): Promise<SearchHit[]> {
  requireScope(caller, "read");
  const audience = resolveAudience(caller, params.audience);
  const memoryStatus: MemoryStatus[] = params.includeStale
    ? ["active", "stale"]
    : ["active"];
  const hits = await hub.search.search({
    text: params.query,
    audience,
    kinds: params.kinds,
    limit: Math.min(params.limit ?? 10, 50),
    entityId: params.entityId,
    memoryStatus,
  });
  const used = hits.filter((h) => h.kind === "memory").map((h) => h.id);
  if (used.length) hub.memory.recordUse(used, caller.actor);
  return hits;
}

/**
 * A memory as the caller may see it: reviewers see everything (governance
 * needs it); readers only active memories visible to their audience.
 * Invisible and missing look the same, so ids don't leak existence.
 */
export function readMemory(
  hub: HubServices,
  caller: Caller,
  id: string,
  audience?: string[] | string,
): Memory {
  const memory = hub.memory.get(id);
  if (memory && caller.scopes.has("review")) return memory;
  requireScope(caller, "read");
  const visible =
    memory &&
    (memory.status === "active" || memory.status === "stale") &&
    isVisible(memory.readers, resolveAudience(caller, audience), hub.access);
  if (!visible) throw new NotFoundError("memory", id);
  return memory;
}

export function proposeMemory(
  hub: HubServices,
  caller: Caller,
  input: ProposeMemoryInput,
): Memory {
  requireScope(caller, "propose");
  return hub.memory.propose(input, caller.actor);
}

export function flagMemory(
  hub: HubServices,
  caller: Caller,
  id: string,
  reason: string,
): Memory {
  requireScope(caller, "propose");
  readMemory(hub, caller, id);
  return hub.memory.flag(id, caller.actor, reason);
}

export interface EntityView {
  entity: Entity;
  facts: Fact[];
}

export function readEntity(
  hub: HubServices,
  caller: Caller,
  id: string,
  opts: { audience?: string[] | string; asOf?: number; history?: boolean },
): EntityView {
  requireScope(caller, "read");
  const audience = resolveAudience(caller, opts.audience);
  const entity = hub.graph.getEntity(id);
  if (!entity || !isVisible(entity.readers, audience, hub.access)) {
    throw new NotFoundError("entity", id);
  }
  const facts = hub.graph.factsFor(id, {
    audience,
    asOf: opts.asOf,
    includeHistory: opts.history,
  });
  return { entity, facts };
}

export function neighbors(
  hub: HubServices,
  caller: Caller,
  opts: {
    id: string;
    depth?: number;
    direction?: Direction;
    types?: string[];
    asOf?: number;
    limit?: number;
    audience?: string[] | string;
  },
): Subgraph {
  requireScope(caller, "read");
  return hub.graph.neighbors({
    entityId: opts.id,
    depth: opts.depth,
    direction: opts.direction,
    factTypes: opts.types,
    asOf: opts.asOf,
    limit: opts.limit,
    audience: resolveAudience(caller, opts.audience),
  });
}
