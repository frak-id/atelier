import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_SCAN_DIRS,
  DISCOVERABLE_CONFIGS,
} from "@frak-sandbox/shared/constants";
import type { DiscoveredConfig } from "../types";

export function discoverConfigFiles(): DiscoveredConfig[] {
  const results: DiscoveredConfig[] = [];
  const seenPaths = new Set<string>();

  for (const { path, category } of DISCOVERABLE_CONFIGS) {
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

  for (const { dir, category } of CONFIG_SCAN_DIRS) {
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
