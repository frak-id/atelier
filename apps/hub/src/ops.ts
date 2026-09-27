/**
 * Every read and write goes through here, whether it came from REST or MCP,
 * so scope checks and use-tracking can't drift between the two surfaces.
 */
import {
  type Direction,
  type Entity,
  type Fact,
  type Memory,
  type MemoryStatus,
  NotFoundError,
  type ProposeMemoryInput,
  type SearchHit,
  type SearchKind,
  type Subgraph,
} from "@atelier/knowledge";
import { type Caller, requireScope } from "./auth.ts";
import type { HubServices } from "./services.ts";

export interface SearchParams {
  query: string;
  kinds?: SearchKind[];
  limit?: number;
  entityId?: string;
  /** Reviewers may also search stale/proposed memories. */
  includeStale?: boolean;
}

export async function search(
  hub: HubServices,
  caller: Caller,
  params: SearchParams,
): Promise<SearchHit[]> {
  requireScope(caller, "read");
  const memoryStatus: MemoryStatus[] = params.includeStale
    ? ["active", "stale"]
    : ["active"];
  const hits = await hub.search.search({
    text: params.query,
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
 * needs it); readers only active/stale memories. Missing looks the same
 * as not-yet-active, so ids don't leak lifecycle state.
 */
export function readMemory(
  hub: HubServices,
  caller: Caller,
  id: string,
): Memory {
  const memory = hub.memory.get(id);
  if (memory && caller.scopes.has("review")) return memory;
  requireScope(caller, "read");
  const visible =
    memory && (memory.status === "active" || memory.status === "stale");
  if (!visible) throw new NotFoundError("memory", id);
  return memory;
}

/** Propose a memory; an exact duplicate returns the existing one. */
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
  opts: { asOf?: number; history?: boolean },
): EntityView {
  requireScope(caller, "read");
  const entity = hub.graph.getEntity(id);
  if (!entity) throw new NotFoundError("entity", id);
  const facts = hub.graph.factsFor(id, {
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
  });
}
