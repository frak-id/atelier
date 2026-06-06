import Elysia from "elysia";
import { agentClient } from "../../container";
import { internalBus } from "../../infrastructure/events";
import { kubeClient } from "../../infrastructure/kubernetes/index.ts";
import {
  buildToolIngressResource,
  getTool,
  listToolInfos,
  toolIngressName,
  toolUrl,
} from "../../orchestrators/tools/registry.ts";
import {
  IdParamSchema,
  ToolActionResponseSchema,
  ToolListResponseSchema,
  ToolSlugParamsSchema,
} from "../../schemas";
import { NotFoundError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { sandboxIdGuard } from "./guard";

const log = createChildLogger("tool-routes");

export const toolsRoutes = new Elysia()
  .use(sandboxIdGuard)
  .get("/:id/tools", ({ sandbox }) => listToolInfos(sandbox.id), {
    params: IdParamSchema,
    response: ToolListResponseSchema,
  })
  .post(
    "/:id/tools/:slug/start",
    async ({ params, sandbox }) => {
      const tool = getTool(params.slug);
      if (!tool) throw new NotFoundError("Tool", params.slug);
      if (sandbox.status !== "running") return { status: "off" as const };

      const url = toolUrl(params.slug, sandbox.id);
      const services = tool.autoStartServices;
      const [primary] = services;

      if (primary) {
        const status = await agentClient.serviceStatus(sandbox.id, primary);
        if (status.running) return { status: "running" as const, url };
      }

      const startServices = async () => {
        for (let i = 0; i < services.length; i++) {
          const name = services[i];
          if (!name) continue;
          await agentClient.serviceStart(sandbox.id, name);
          if (tool.startDelayMs && i < services.length - 1) {
            await new Promise((r) => setTimeout(r, tool.startDelayMs));
          }
        }
      };
      startServices().catch((err) => {
        log.warn(
          { sandboxId: sandbox.id, slug: params.slug, error: String(err) },
          "Tool start failed",
        );
      });

      const ingress = buildToolIngressResource(params.slug, sandbox.id);
      if (ingress) {
        try {
          await kubeClient.createResource(ingress);
        } catch (err) {
          log.warn(
            { sandboxId: sandbox.id, slug: params.slug, error: err },
            "Failed to create tool ingress",
          );
        }
      }

      internalBus.emit("sandbox.poll-services", sandbox.id);
      return { status: "starting" as const, url };
    },
    {
      params: ToolSlugParamsSchema,
      response: ToolActionResponseSchema,
    },
  )
  .post(
    "/:id/tools/:slug/stop",
    async ({ params, sandbox }) => {
      const tool = getTool(params.slug);
      if (!tool) throw new NotFoundError("Tool", params.slug);
      if (sandbox.status !== "running") return { status: "off" as const };

      Promise.all(
        [...tool.autoStartServices]
          .reverse()
          .map((name) =>
            agentClient.serviceStop(sandbox.id, name).catch(() => {}),
          ),
      ).catch(() => {});

      const ingressName = toolIngressName(params.slug, sandbox.id);
      if (ingressName) {
        kubeClient.deleteResource("Ingress", ingressName).catch(() => {});
      }

      internalBus.emit("sandbox.poll-services", sandbox.id);
      return { status: "off" as const };
    },
    {
      params: ToolSlugParamsSchema,
      response: ToolActionResponseSchema,
    },
  );
