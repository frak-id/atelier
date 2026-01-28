import { CONFIG_SCAN_DIRS, DISCOVERABLE_CONFIGS } from "../constants.ts";
import type { DiscoveredConfig } from "../types.ts";

function existsSync(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

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
        size = Deno.statSync(path).size;
      } catch {
        //
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
      for (const entry of Deno.readDirSync(dir)) {
        const file = entry.name;
        if (
          !file.endsWith(".json") &&
          !file.endsWith(".js") &&
          !file.endsWith(".ts")
        ) {
          continue;
        }

        const fullPath = `${dir}/${file}`;
        if (seenPaths.has(fullPath)) continue;
        seenPaths.add(fullPath);

        try {
          const stats = Deno.statSync(fullPath);
          if (!stats.isFile) continue;

          results.push({
            path: fullPath,
            displayPath: fullPath.replace("/home/dev", "~"),
            category,
            exists: true,
            size: stats.size,
          });
        } catch {
          //
        }
      }
    } catch {
      //
    }
  }

  return results.filter((r) => r.exists);
}
