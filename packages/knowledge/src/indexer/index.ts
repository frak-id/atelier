/**
 * The code indexer: pure extraction of a {@link RepositoryIndex} from a
 * checkout on disk. Never touches the DB — applying the result to the
 * graph/document stores is a separate step (`applyIndex`, in `apply.ts`),
 * so this can run anywhere (a sandbox, CI) and ship its output as JSON.
 */

import type {
  EntityInput,
  FactInput,
  IndexRepositoryInput,
  RepositoryIndex,
} from "../types.ts";
import { ORG_PRINCIPAL } from "../types.ts";
import { buildCodeownersFacts } from "./codeowners.ts";
import { listRepoFiles } from "./files.ts";
import { scanImports } from "./imports.ts";
import { scanManifests } from "./manifests.ts";
import { buildDocuments } from "./markdown.ts";

export {
  buildCodeownersFacts,
  matchesPattern,
  ownerEntityId,
  parseCodeowners,
  resolveOwners,
} from "./codeowners.ts";
export { listRepoFiles, readRepoFile } from "./files.ts";
export { scanImports } from "./imports.ts";
export { scanManifests } from "./manifests.ts";
export { buildDocuments, githubSlug } from "./markdown.ts";
export type { CrateInfo, PackageInfo } from "./model.ts";
export { extractReadmeLede } from "./readme.ts";

function factKey(f: FactInput): string {
  return `${f.type}\u0000${f.from}\u0000${f.to}\u0000${JSON.stringify(f.attrs ?? {})}`;
}

/** Dedupes entities by id (last write wins) and sorts for stable diffs. */
function dedupeEntities(entities: EntityInput[]): EntityInput[] {
  const byId = new Map<string, EntityInput>();
  for (const e of entities) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function dedupeFacts(facts: FactInput[]): FactInput[] {
  const byKey = new Map<string, FactInput>();
  for (const f of facts) byKey.set(factKey(f), f);
  return [...byKey.values()].sort((a, b) =>
    factKey(a).localeCompare(factKey(b)),
  );
}

/**
 * Extracts what `input.root` says about itself at `input.revision`: repo,
 * package/crate/dependency entities, containment/dependency/import facts,
 * CODEOWNERS ownership and chunked markdown documents. Bad manifests are
 * recorded as warnings, never thrown.
 */
export async function indexRepository(
  input: IndexRepositoryInput,
): Promise<RepositoryIndex> {
  const start = Date.now();
  const readers = input.readers ?? [ORG_PRINCIPAL];
  const includeExternalDeps = input.includeExternalDeps ?? false;
  const includeFiles = input.includeFiles ?? false;

  const files = await listRepoFiles(input.root);
  const fileSet = new Set(files);

  const manifestResult = await scanManifests(input.root, files, {
    repo: input.repo,
    revision: input.revision,
    readers,
    webUrl: input.webUrl,
    includeExternalDeps,
  });

  const importResult = await scanImports(input.root, {
    repo: input.repo,
    files,
    npmPackages: manifestResult.npmPackages,
    crates: manifestResult.crates,
    readers,
    includeFiles,
  });

  const ownerDirs = [
    ...manifestResult.npmPackages.map((p) => ({
      dir: p.dir,
      entityId: p.entityId,
    })),
    ...manifestResult.crates.map((c) => ({
      dir: c.dir,
      entityId: c.entityId,
    })),
  ];
  const codeownersResult = await buildCodeownersFacts(input.root, fileSet, {
    repo: input.repo,
    readers,
    dirs: ownerDirs,
  });

  const documentsResult = await buildDocuments(input.root, files, {
    repo: input.repo,
    revision: input.revision,
    webUrl: input.webUrl,
    readers,
    owners: ownerDirs,
  });

  const entities = dedupeEntities([
    ...manifestResult.entities,
    ...importResult.entities,
    ...codeownersResult.entities,
  ]);
  const facts = dedupeFacts([
    ...manifestResult.facts,
    ...importResult.facts,
    ...codeownersResult.facts,
  ]);
  const documents = [...documentsResult.documents].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const warnings = [
    ...manifestResult.warnings,
    ...importResult.warnings,
    ...documentsResult.warnings,
  ];

  const packages = entities.filter(
    (e) => e.type === "package" || e.type === "crate",
  ).length;

  return {
    repo: input.repo,
    revision: input.revision,
    entities,
    facts,
    documents,
    warnings,
    stats: {
      files: files.length,
      packages,
      documents: documents.length,
      durationMs: Date.now() - start,
    },
  };
}
