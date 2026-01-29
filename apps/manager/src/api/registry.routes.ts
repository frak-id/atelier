import { REGISTRY } from "@frak-sandbox/shared/constants";
import { $ } from "bun";
import { Elysia, t } from "elysia";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("registry-routes");

const VERDACCIO_URL = `http://127.0.0.1:${REGISTRY.PORT}`;

const RegistryStatusSchema = t.Object({
  online: t.Boolean(),
  packageCount: t.Number(),
  disk: t.Object({
    usedBytes: t.Number(),
    totalBytes: t.Number(),
    usedPercent: t.Number(),
  }),
  uplink: t.Object({
    url: t.String(),
    healthy: t.Boolean(),
  }),
});

async function checkVerdaccioHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${VERDACCIO_URL}/-/ping`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function getPackageCount(): Promise<number> {
  try {
    const res = await fetch(`${VERDACCIO_URL}/-/verdaccio/data/packages`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 0;
    const packages = (await res.json()) as unknown[];
    return packages.length;
  } catch {
    return 0;
  }
}

async function getDiskStats(): Promise<{
  usedBytes: number;
  totalBytes: number;
  usedPercent: number;
}> {
  try {
    const result =
      await $`df -B1 ${REGISTRY.STORAGE_DIR} 2>/dev/null | tail -1 | awk '{print $3, $2, $5}'`
        .quiet()
        .nothrow();
    const parts = result.stdout.toString().trim().split(/\s+/);
    if (parts.length >= 3) {
      const usedBytes = Number.parseInt(parts[0] ?? "0", 10);
      const totalBytes = Number.parseInt(parts[1] ?? "0", 10);
      const usedPercent = Number.parseFloat((parts[2] ?? "0").replace("%", ""));
      return { usedBytes, totalBytes, usedPercent };
    }
  } catch (err) {
    log.debug({ err }, "Failed to get disk stats");
  }
  return { usedBytes: 0, totalBytes: 0, usedPercent: 0 };
}

async function checkUplinkHealth(): Promise<boolean> {
  try {
    const res = await fetch("https://registry.npmjs.org/-/ping", {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const registryRoutes = new Elysia({ prefix: "/registry" }).get(
  "/",
  async () => {
    const [online, packageCount, disk, uplinkHealthy] = await Promise.all([
      checkVerdaccioHealth(),
      getPackageCount(),
      getDiskStats(),
      checkUplinkHealth(),
    ]);

    return {
      online,
      packageCount,
      disk,
      uplink: {
        url: "https://registry.npmjs.org",
        healthy: uplinkHealthy,
      },
    };
  },
  {
    response: RegistryStatusSchema,
    detail: {
      tags: ["system"],
      summary: "Get registry cache status",
    },
  },
);
