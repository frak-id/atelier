import { Elysia } from "elysia";
import { agentClient, workspaceService } from "../../container";
import { CaddyService } from "../../infrastructure/proxy";
import {
  DevCommandListResponseSchema,
  DevCommandLogsQuerySchema,
  DevCommandLogsResponseSchema,
  DevCommandNameParamsSchema,
  DevCommandStartResponseSchema,
  DevCommandStopResponseSchema,
  IdParamSchema,
} from "../../schemas";
import { NotFoundError } from "../../shared/errors";
import { config } from "../../shared/lib/config";
import { createChildLogger } from "../../shared/lib/logger";
import { sandboxIdGuard } from "./guard";

const log = createChildLogger("sandbox-routes");

export const devRoutes = new Elysia()
  .use(sandboxIdGuard)
  .get(
    "/:id/dev",
    async ({ sandbox }) => {
      const workspace = sandbox.workspaceId
        ? workspaceService.getById(sandbox.workspaceId)
        : undefined;
      const configuredCommands = workspace?.config.devCommands ?? [];

      const runtimeStatus = await agentClient.devList(sandbox.id);

      return {
        commands: configuredCommands.map((cmd) => {
          const runtime = runtimeStatus.commands.find(
            (r) => r.name === cmd.name,
          );
          const isRunning = runtime?.status === "running";

          let devUrl: string | undefined;
          let defaultDevUrl: string | undefined;
          let extraDevUrls:
            | Array<{ alias: string; port: number; url: string }>
            | undefined;

          if (isRunning && cmd.port) {
            devUrl = `https://dev-${cmd.name}-${sandbox.id}.${config.domain.baseDomain}`;
            if (cmd.isDefault) {
              defaultDevUrl = `https://dev-${sandbox.id}.${config.domain.baseDomain}`;
            }
          }

          if (isRunning && cmd.extraPorts?.length) {
            extraDevUrls = cmd.extraPorts.map((ep) => ({
              alias: ep.alias,
              port: ep.port,
              url: `https://dev-${cmd.name}-${ep.alias}-${sandbox.id}.${config.domain.baseDomain}`,
            }));
          }

          return {
            ...cmd,
            status: runtime?.status ?? "stopped",
            pid: runtime?.pid,
            startedAt: runtime?.startedAt,
            exitCode: runtime?.exitCode,
            devUrl,
            defaultDevUrl,
            extraDevUrls,
          };
        }),
      };
    },
    {
      params: IdParamSchema,
      response: DevCommandListResponseSchema,
    },
  )
  .post(
    "/:id/dev/:name/start",
    async ({ params, sandbox }) => {
      const workspace = sandbox.workspaceId
        ? workspaceService.getById(sandbox.workspaceId)
        : undefined;
      const devCommand = workspace?.config.devCommands?.find(
        (c) => c.name === params.name,
      );
      if (!devCommand) throw new NotFoundError("DevCommand", params.name);

      const result = await agentClient.devStart(
        sandbox.id,
        params.name,
        devCommand,
      );

      let devUrl: string | undefined;
      let defaultDevUrl: string | undefined;
      let extraDevUrls:
        | Array<{ alias: string; port: number; url: string }>
        | undefined;

      if (devCommand.port) {
        try {
          const urls = await CaddyService.registerDevRoute(
            sandbox.id,
            sandbox.runtime.ipAddress,
            params.name,
            devCommand.port,
            devCommand.isDefault ?? false,
            devCommand.extraPorts,
          );
          devUrl = urls.namedUrl;
          defaultDevUrl = urls.defaultUrl;
          extraDevUrls = urls.extraDevUrls;
        } catch (err) {
          log.warn(
            { sandboxId: sandbox.id, name: params.name, error: err },
            "Failed to register dev route",
          );
        }
      }

      return {
        ...result,
        devUrl,
        defaultDevUrl,
        extraDevUrls,
      };
    },
    {
      params: DevCommandNameParamsSchema,
      response: DevCommandStartResponseSchema,
    },
  )
  .post(
    "/:id/dev/:name/stop",
    async ({ params, sandbox }) => {
      const workspace = sandbox.workspaceId
        ? workspaceService.getById(sandbox.workspaceId)
        : undefined;
      const devCommand = workspace?.config.devCommands?.find(
        (c) => c.name === params.name,
      );

      const result = await agentClient.devStop(sandbox.id, params.name);

      if (devCommand?.port) {
        try {
          await CaddyService.removeDevRoute(
            sandbox.id,
            params.name,
            devCommand.isDefault ?? false,
            devCommand.extraPorts,
          );
        } catch (err) {
          log.warn(
            { sandboxId: sandbox.id, name: params.name, error: err },
            "Failed to remove dev route",
          );
        }
      }

      return result;
    },
    {
      params: DevCommandNameParamsSchema,
      response: DevCommandStopResponseSchema,
    },
  )
  .get(
    "/:id/dev/:name/logs",
    async ({ params, query, sandbox }) => {
      const offset = query.offset ? Number.parseInt(query.offset, 10) : 0;
      const limit = query.limit ? Number.parseInt(query.limit, 10) : 10000;

      return agentClient.devLogs(sandbox.id, params.name, offset, limit);
    },
    {
      params: DevCommandNameParamsSchema,
      query: DevCommandLogsQuerySchema,
      response: DevCommandLogsResponseSchema,
    },
  );
