/** Reads a CodeWiki output directory and turns each top-level page into an
 * Onyx ingestion document. */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface OnyxDocument {
  id: string;
  semanticIdentifier: string;
  title: string;
  sections: { text: string; link: string }[];
  metadata: Record<string, string | string[]>;
  docUpdatedAt: string;
}

export interface WikiPage {
  /** File stem, e.g. "CI_CD_Workflows" — also the module_tree.json key when
   * the page corresponds to one module. */
  stem: string;
  title: string;
  content: string;
  hash: string;
}

interface ModuleTreeNode {
  path?: string;
  children?: Record<string, ModuleTreeNode>;
}

type ModuleTree = Record<string, ModuleTreeNode>;

interface Metadata {
  generation_info?: {
    commit_id?: string;
  };
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function titleFromContent(content: string, stem: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match?.[1]) {
    return match[1].trim();
  }
  return stem.replace(/_/g, " ");
}

/** Lists every top-level `*.md` page in `wikiDir` (excluding `temp/`, which
 * isn't a page — it's CodeWiki's dependency-graph cache). */
export async function readWikiPages(wikiDir: string): Promise<WikiPage[]> {
  const entries = await readdir(wikiDir, { withFileTypes: true });
  const pages: WikiPage[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const stem = entry.name.slice(0, -3);
    const content = await readFile(path.join(wikiDir, entry.name), "utf8");
    pages.push({
      stem,
      title: titleFromContent(content, stem),
      content,
      hash: hashContent(content),
    });
  }
  return pages;
}

/** Reads `module_tree.json`; returns `{}` if it's absent (whole-repo fallback
 * mode, or a page-less run). */
export async function readModuleTree(wikiDir: string): Promise<ModuleTree> {
  try {
    const raw = await readFile(path.join(wikiDir, "module_tree.json"), "utf8");
    return JSON.parse(raw) as ModuleTree;
  } catch {
    return {};
  }
}

/** Reads `metadata.json`'s `generation_info.commit_id`; undefined if the
 * file is absent or doesn't have one (e.g. a run that never finished). */
export async function readCommit(wikiDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(wikiDir, "metadata.json"), "utf8");
    const metadata = JSON.parse(raw) as Metadata;
    return metadata.generation_info?.commit_id;
  } catch {
    return undefined;
  }
}

/** Finds the module path for `stem` by walking `tree` (module_tree.json is
 * a forest of named modules, each optionally nested under `children`). */
export function findModulePath(
  tree: ModuleTree,
  stem: string,
): string | undefined {
  for (const [name, node] of Object.entries(tree)) {
    if (name === stem) return node.path;
    if (node.children) {
      const found = findModulePath(node.children, stem);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function pageLink(
  owner: string,
  repo: string,
  commit: string | undefined,
  modulePath: string | undefined,
): string {
  const ref = commit || "HEAD";
  const suffix = modulePath ? `/${modulePath}` : "";
  return `https://github.com/${owner}/${repo}/tree/${ref}${suffix}`;
}

/** Splits a page's markdown on `## ` headings, keeping the heading text as
 * part of each section (Onyx sections are heading+body chunks). The intro
 * before the first `## ` (title + purpose) becomes its own section. */
export function splitSections(content: string): string[] {
  const lines = content.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## ") && current.length > 0) {
      sections.push(current.join("\n").trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    const trailing = current.join("\n").trim();
    if (trailing.length > 0) sections.push(trailing);
  }
  return sections;
}

export interface BuildDocumentOptions {
  owner: string;
  repo: string;
  page: WikiPage;
  moduleTree: ModuleTree;
  commit: string | undefined;
  generatedAt: string;
}

export function buildOnyxDocument(opts: BuildDocumentOptions): OnyxDocument {
  const { owner, repo, page, moduleTree, commit, generatedAt } = opts;
  const modulePath = findModulePath(moduleTree, page.stem);
  const link = pageLink(owner, repo, commit, modulePath);
  const sections = splitSections(page.content).map((text) => ({
    text,
    link,
  }));

  const metadata: Record<string, string | string[]> = {
    repo: `${owner}/${repo}`,
    generator: "codewiki",
  };
  if (modulePath) metadata.module = modulePath;
  if (commit) metadata.commit = commit;

  return {
    id: `codewiki:${owner}/${repo}:${page.stem}`,
    semanticIdentifier: `${repo} · ${page.title}`,
    title: page.title,
    sections,
    metadata,
    docUpdatedAt: generatedAt,
  };
}

export async function buildDocumentsFromWiki(
  owner: string,
  repo: string,
  wikiDir: string,
  generatedAt: string,
): Promise<{
  documents: OnyxDocument[];
  pages: WikiPage[];
  commit: string | undefined;
}> {
  const [pages, moduleTree, commit] = await Promise.all([
    readWikiPages(wikiDir),
    readModuleTree(wikiDir),
    readCommit(wikiDir),
  ]);
  const documents = pages.map((page) =>
    buildOnyxDocument({ owner, repo, page, moduleTree, commit, generatedAt }),
  );
  return { documents, pages, commit };
}
