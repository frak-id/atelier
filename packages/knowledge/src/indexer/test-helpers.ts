/**
 * Test-only fixture builder: writes a nested `{path: content}` tree under a
 * fresh tmp dir. Colocated with the indexer tests (not exported from the
 * package barrel).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type FixtureTree = Record<string, string>;

export async function writeFixture(tree: FixtureTree): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "knowledge-indexer-"));
  for (const [relPath, content] of Object.entries(tree)) {
    const abs = join(root, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

export async function cleanupFixture(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
