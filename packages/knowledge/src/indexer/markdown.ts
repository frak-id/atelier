/**
 * Markdown → documents: chunk each file by headings (levels 1–3), split
 * oversized chunks on paragraph boundaries, dedupe GitHub-style anchor
 * slugs the way GitHub itself does (`-1`, `-2`, …).
 */
import type { DocumentInput, Readers } from "../types.ts";
import { sha256 } from "../util.ts";
import { readRepoFile, rpath } from "./files.ts";
import { findOwner, sortOwners } from "./model.ts";
import { stripFrontmatter } from "./readme.ts";

const MAX_DOC_FILES = 2000;
const MAX_DOC_BYTES = 512 * 1024;
const MAX_CHUNK_CHARS = 2500;

/** GitHub's heading-anchor algorithm: lowercase, drop punctuation, hyphenate. */
export function githubSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

interface HeadingChunk {
  level: number;
  heading: string;
  content: string;
}

/** Splits a markdown body into the intro (pre-heading) text and chunks by heading (levels 1–3; deeper headings stay inline as content). */
function splitByHeadings(body: string): {
  intro: string;
  chunks: HeadingChunk[];
} {
  const lines = body.split(/\r?\n/);
  const chunks: { level: number; heading: string; content: string[] }[] = [];
  let current:
    | { level: number; heading: string; content: string[] }
    | undefined;
  const intro: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = /^(```|~~~)/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
      }
      (current ? current.content : intro).push(line);
      continue;
    }
    if (!inFence) {
      const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (headingMatch) {
        const level = (headingMatch[1] ?? "").length;
        const text = (headingMatch[2] ?? "").replace(/\s+#+\s*$/, "").trim();
        if (level >= 1 && level <= 3) {
          if (current) chunks.push(current);
          current = { level, heading: text, content: [] };
          continue;
        }
      }
    }
    (current ? current.content : intro).push(line);
  }
  if (current) chunks.push(current);

  return {
    intro: intro.join("\n"),
    chunks: chunks.map((c) => ({
      level: c.level,
      heading: c.heading,
      content: c.content.join("\n"),
    })),
  };
}

/** Ancestor heading trail (levels 1–3) for each chunk, in document order. */
function buildTrails(chunks: HeadingChunk[]): string[][] {
  const stack: { level: number; text: string }[] = [];
  const trails: string[][] = [];
  for (const c of chunks) {
    while (stack.length && (stack.at(-1)?.level ?? 0) >= c.level) stack.pop();
    stack.push({ level: c.level, text: c.heading });
    trails.push(stack.map((s) => s.text));
  }
  return trails;
}

/** Splits oversized content on paragraph (`\n\n`) boundaries. */
function splitBig(content: string): string[] {
  if (content.length <= MAX_CHUNK_CHARS) return [content];
  const paragraphs = content.split(/\n{2,}/);
  const parts: string[] = [];
  let buf = "";
  for (const p of paragraphs) {
    const candidate = buf ? `${buf}\n\n${p}` : p;
    if (candidate.length > MAX_CHUNK_CHARS && buf) {
      parts.push(buf);
      buf = p;
    } else {
      buf = candidate;
    }
  }
  if (buf) parts.push(buf);
  return parts.length ? parts : [content];
}

interface ChunkEntry {
  /** Ancestor trail *including* this chunk's own (unsuffixed) heading. */
  trail: string[];
  heading: string;
  body: string;
}

function buildFileDocuments(
  path: string,
  text: string,
  opts: {
    repo: string;
    revision: string;
    webUrl?: string;
    readers: Readers;
    entityIds: string[];
  },
): DocumentInput[] {
  const raw = stripFrontmatter(text);
  const { intro, chunks } = splitByHeadings(raw);
  const trails = buildTrails(chunks);
  const firstH1 = chunks.find((c) => c.level === 1)?.heading;
  const introLabel = firstH1 ?? rpath.basename(path);

  const entries: ChunkEntry[] = [];
  if (intro.trim()) {
    entries.push({ trail: [introLabel], heading: introLabel, body: intro });
  }
  chunks.forEach((c, i) => {
    if (!c.content.trim()) return;
    entries.push({
      trail: trails[i] ?? [c.heading],
      heading: c.heading,
      body: c.content,
    });
  });

  const slugCounts = new Map<string, number>();
  const docs: DocumentInput[] = [];
  for (const entry of entries) {
    const parts = splitBig(entry.body.trim());
    parts.forEach((partBody, idx) => {
      if (!partBody.trim()) return;
      const heading =
        idx === 0 ? entry.heading : `${entry.heading} (${idx + 1})`;
      const trail = [...entry.trail.slice(0, -1), heading];
      const title = `${path} › ${trail.join(" › ")}`;
      let slug = githubSlug(heading) || "section";
      const seen = slugCounts.get(slug) ?? 0;
      slugCounts.set(slug, seen + 1);
      if (seen > 0) slug = `${slug}-${seen}`;
      const id = `doc:${opts.repo}:${path}#${slug}`;
      docs.push({
        id,
        collection: `repo:${opts.repo}`,
        title,
        body: partBody,
        path,
        url: opts.webUrl ? `${opts.webUrl}/${path}#${slug}` : undefined,
        revision: opts.revision,
        entityIds: opts.entityIds,
        readers: opts.readers,
        hash: sha256(`${title}\n${partBody}`),
      });
    });
  }
  return docs;
}

export interface MarkdownScanOpts {
  repo: string;
  revision: string;
  webUrl?: string;
  readers: Readers;
  owners: { dir: string; entityId: string }[];
}

export async function buildDocuments(
  root: string,
  files: string[],
  opts: MarkdownScanOpts,
): Promise<{ documents: DocumentInput[]; warnings: string[] }> {
  const warnings: string[] = [];
  const documents: DocumentInput[] = [];
  const mdFiles = files
    .filter((f) => /\.mdx?$/i.test(f))
    .sort()
    .slice(0, MAX_DOC_FILES);
  const sortedOwners = sortOwners(opts.owners);

  for (const file of mdFiles) {
    const text = await readRepoFile(root, file, MAX_DOC_BYTES);
    if (text === undefined) continue;
    const owner = findOwner(file, sortedOwners);
    const entityIds = owner
      ? [owner, `repo:${opts.repo}`]
      : [`repo:${opts.repo}`];
    try {
      documents.push(
        ...buildFileDocuments(file, text, {
          repo: opts.repo,
          revision: opts.revision,
          webUrl: opts.webUrl,
          readers: opts.readers,
          entityIds,
        }),
      );
    } catch (err) {
      warnings.push(`failed to chunk ${file}: ${(err as Error).message}`);
    }
  }

  return { documents, warnings };
}
