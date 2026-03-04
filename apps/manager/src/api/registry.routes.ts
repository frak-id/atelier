import { Elysia, t } from "elysia";
import { RegistryService } from "../infrastructure/registry/index.ts";

const RegistryStatusSchema = t.Object({
  online: t.Boolean(),
  packageCount: t.Number(),
  uplink: t.Object({
    url: t.String(),
    healthy: t.Boolean(),
  }),
  settings: t.Object({
    evictionDays: t.Number(),
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
        evictionDays: t.Number(),
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
      return {
        message: "Cache purged",
        deletedCount: result.deletedCount,
      };
    },
    {
      response: t.Object({
        message: t.String(),
        deletedCount: t.Number(),
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
