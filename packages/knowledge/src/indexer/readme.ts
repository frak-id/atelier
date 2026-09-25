/**
 * README summary extraction, shared by the repo entity and every npm
 * package entity: the first prose paragraph, badges/markdown stripped,
 * capped so it stays a *summary* rather than a copy of the file.
 */

const MAX_SUMMARY_CHARS = 300;

/** Strips a leading `---\n...\n---` YAML frontmatter block, if present. */
export function stripFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

const BADGE_OR_HTML = /^(\[!\[|!\[|<img\b|<p\b|<div\b|<!--|<a\b)/i;
const HR = /^(---+|\*\*\*+|___+)$/;

/**
 * The first paragraph of actual prose in a README: skips frontmatter,
 * headings, badge rows, raw HTML and horizontal rules, stops at the first
 * blank line after prose has started.
 */
export function extractReadmeLede(markdown: string): string | undefined {
  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  const paragraph: string[] = [];
  let inFence = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line === "") {
      if (paragraph.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      if (paragraph.length) break;
      continue;
    }
    if (BADGE_OR_HTML.test(line) || HR.test(line)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line);
  }
  if (!paragraph.length) return undefined;
  const text = stripMarkdownInline(paragraph.join(" "));
  if (!text) return undefined;
  return text.length > MAX_SUMMARY_CHARS
    ? text.slice(0, MAX_SUMMARY_CHARS).trim()
    : text;
}

function stripMarkdownInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]{1,3}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
