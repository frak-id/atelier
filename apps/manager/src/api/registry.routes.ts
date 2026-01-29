import { Elysia, t } from "elysia";
import { internalService } from "../container.ts";
import { RegistryService } from "../infrastructure/registry/index.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("registry-routes");

const RegistryStatusSchema = t.Object({
  enabled: t.Boolean(),
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
  settings: t.Object({
    evictionDays: t.Number(),
    storagePath: t.String(),
  }),
});

export const registryRoutes = new Elysia({ prefix: "/registry" })
  .get("/", async () => RegistryService.getStatus(), {
    response: RegistryStatusSchema,
    detail: {
      tags: ["system"],
      summary: "Get registry cache status",
    },
  })
  .post(
    "/enable",
    async () => {
      await RegistryService.start();
      internalService.syncRegistryToSandboxes(true).catch((error) => {
        log.error({ error }, "Failed to sync registry to sandboxes on enable");
      });
      return { message: "Registry cache enabled" };
    },
    {
      response: t.Object({ message: t.String() }),
      detail: {
        tags: ["system"],
        summary: "Enable and start the registry cache",
      },
    },
  )
  .post(
    "/disable",
    async () => {
      await RegistryService.stop();
      internalService.syncRegistryToSandboxes(false).catch((error) => {
        log.error({ error }, "Failed to sync registry to sandboxes on disable");
      });
      return { message: "Registry cache disabled" };
    },
    {
      response: t.Object({ message: t.String() }),
      detail: {
        tags: ["system"],
        summary: "Disable and stop the registry cache",
      },
    },
  )
  .put(
    "/settings",
    async ({ body }) => {
      const settings = await RegistryService.updateSettings(body);
      return settings;
    },
    {
      body: t.Object({
        evictionDays: t.Optional(t.Number({ minimum: 1, maximum: 365 })),
      }),
      response: t.Object({
        enabled: t.Boolean(),
        evictionDays: t.Number(),
        storagePath: t.String(),
      }),
      detail: {
        tags: ["system"],
        summary: "Update registry cache settings",
      },
    },
  )
  .post(
    "/purge",
    async () => {
      const result = await RegistryService.purgeCache();
      return { message: "Cache purged", freedBytes: result.freedBytes };
    },
    {
      response: t.Object({
        message: t.String(),
        freedBytes: t.Number(),
      }),
      detail: {
        tags: ["system"],
        summary: "Purge all cached packages",
      },
    },
  )
  .post(
    "/evict",
    async () => {
      const deletedCount = await RegistryService.runEvictionNow();
      return { message: "Eviction completed", deletedCount };
    },
    {
      response: t.Object({
        message: t.String(),
        deletedCount: t.Number(),
      }),
      detail: {
        tags: ["system"],
        summary: "Run cache eviction now (removes stale packages)",
      },
    },
  );
