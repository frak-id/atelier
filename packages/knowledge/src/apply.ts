/**
 * Applies a pure `RepositoryIndex` extraction (see `types.ts`) to the
 * graph and document stores. Idempotent per revision: re-applying retires
 * entities/documents/facts the index no longer states instead of leaving
 * stale data behind.
 */
import type {
  ApplyIndexReport,
  DocumentStore,
  GraphStore,
  RepositoryIndex,
} from "./types.ts";

export interface ApplyIndexStores {
  graph: GraphStore;
  documents: DocumentStore;
}

export function applyIndex(
  index: RepositoryIndex,
  stores: ApplyIndexStores,
): ApplyIndexReport {
  const sourceKey = `indexer:${index.repo}`;

  const upserted = stores.graph.upsertEntities(index.entities, { sourceKey });
  const keepIds = index.entities.map((entity) => entity.id);
  const retired = stores.graph.retireEntities(sourceKey, keepIds);

  const facts = stores.graph.assertFacts(
    { key: sourceKey, revision: index.revision },
    index.facts,
  );

  const documents = stores.documents.replaceCollection(
    `repo:${index.repo}`,
    index.documents,
  );

  return {
    repo: index.repo,
    revision: index.revision,
    entities: { upserted, retired },
    facts,
    documents,
  };
}
