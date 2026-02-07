import { Elysia } from "elysia";
import { sandboxService, workspaceService } from "../container.ts";
import { WellKnownAtelierConfigSchema } from "../schemas/well-known.ts";
import { config } from "../shared/lib/config.ts";
import { createInternalGuard, getRequestIp } from "../shared/lib/internal.ts";

function isSandboxId(value: string): boolean {
  return /^[a-z0-9]{12}$/.test(value);
}

const internalGuard = createInternalGuard(() => sandboxService.getAll());

export const internalWellKnownRoutes = new Elysia({
  prefix: "/internal",
}).guard({ beforeHandle: internalGuard }, (app) =>
  app.get(
    "/.well-known/atelier.json",
    ({ request, server, set }) => {
      const url = new URL(request.url);
      const querySandboxId = url.searchParams.get("sandboxId") ?? undefined;
      const headerSandboxId =
        request.headers.get("x-atelier-sandbox-id") ?? undefined;

      const sandboxId =
        (querySandboxId && isSandboxId(querySandboxId)
          ? querySandboxId
          : undefined) ??
        (headerSandboxId && isSandboxId(headerSandboxId)
          ? headerSandboxId
          : undefined);

      if (!sandboxId) {
        set.status = 400;
        return {
          baseDomain: config.domain.baseDomain,
          host: request.headers.get("host") ?? "",
        };
      }

      const sandbox = sandboxService.getById(sandboxId);
      if (!sandbox) {
        set.status = 404;
        return {
          baseDomain: config.domain.baseDomain,
          host: request.headers.get("host") ?? "",
          sandboxId,
        };
      }

      const callerIp = getRequestIp(request, server);
      if (callerIp && callerIp !== sandbox.runtime.ipAddress) {
        set.status = 403;
        return {
          baseDomain: config.domain.baseDomain,
          host: request.headers.get("host") ?? "",
          sandboxId: sandbox.id,
        };
      }

      const workspace = sandbox.workspaceId
        ? workspaceService.getById(sandbox.workspaceId)
        : undefined;

      const named: Record<string, string> = {};
      let defaultDevUrl: string | undefined;

      for (const cmd of workspace?.config.devCommands ?? []) {
        if (cmd.port) {
          named[cmd.name] =
            `https://dev-${cmd.name}-${sandbox.id}.${config.domain.baseDomain}`;
          if (cmd.isDefault) {
            defaultDevUrl = `https://dev-${sandbox.id}.${config.domain.baseDomain}`;
          }
        }

        const extraPorts = cmd.extraPorts;
        if (extraPorts && extraPorts.length > 0) {
          for (const ep of extraPorts) {
            const name = `${cmd.name}-${ep.alias}`;
            named[name] =
              `https://dev-${cmd.name}-${ep.alias}-${sandbox.id}.${config.domain.baseDomain}`;
          }
        }
      }

      return {
        baseDomain: config.domain.baseDomain,
        host: request.headers.get("host") ?? "",
        sandboxId: sandbox.id,
        routes: {
          ...sandbox.runtime.urls,
          dev: {
            named,
            default: defaultDevUrl,
          },
        },
      };
    },
    {
      response: WellKnownAtelierConfigSchema,
      detail: {
        tags: ["config"],
        description:
          "Internal runtime config endpoint for sandboxes (sandbox-only access).",
      },
    },
  ),
);
