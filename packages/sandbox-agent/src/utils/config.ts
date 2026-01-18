import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONFIG_DIRECTORIES,
  CONFIG_PATH,
  KNOWN_CONFIG_PATHS,
} from "../constants";
import type { DiscoveredConfig, SandboxConfig } from "../types";

export async function loadConfig(): Promise<SandboxConfig | null> {
  try {
    const content = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function discoverConfigFiles(): DiscoveredConfig[] {
  const results: DiscoveredConfig[] = [];
  const seenPaths = new Set<string>();

  for (const { path, category } of KNOWN_CONFIG_PATHS) {
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);

    const exists = existsSync(path);
    let size: number | undefined;
    if (exists) {
      try {
        size = statSync(path).size;
      } catch {
        /* empty */
      }
    }

    results.push({
      path,
      displayPath: path.replace("/home/dev", "~"),
      category,
      exists,
      size,
    });
  }

  for (const { dir, category } of CONFIG_DIRECTORIES) {
    if (!existsSync(dir)) continue;

    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (
          !file.endsWith(".json") &&
          !file.endsWith(".js") &&
          !file.endsWith(".ts")
        ) {
          continue;
        }

        const fullPath = join(dir, file);
        if (seenPaths.has(fullPath)) continue;
        seenPaths.add(fullPath);

        try {
          const stats = statSync(fullPath);
          if (!stats.isFile()) continue;

          results.push({
            path: fullPath,
            displayPath: fullPath.replace("/home/dev", "~"),
            category,
            exists: true,
            size: stats.size,
          });
        } catch {
          /* empty */
        }
      }
    } catch {
      /* empty */
    }
  }

  return results.filter((r) => r.exists);
}
