import { Elysia } from "elysia";
import { SystemModelConfigSchema } from "../schemas/system-model-config.ts";
import { systemAiService } from "../container.ts";

export const systemModelConfigRoutes = new Elysia({
  prefix: "/system-model-config",
})
  .get("/", () => systemAiService.getModelConfig(), {
    detail: {
      tags: ["system"],
      summary: "Get system sandbox model configuration",
    },
    response: SystemModelConfigSchema,
  })
  .put(
    "/",
    ({ body }) => {
      systemAiService.setModelConfig(body);
      return systemAiService.getModelConfig();
    },
    {
      detail: {
        tags: ["system"],
        summary: "Update system sandbox model configuration",
      },
      body: SystemModelConfigSchema,
      response: SystemModelConfigSchema,
    },
  );
