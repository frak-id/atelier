import { Elysia } from "elysia";
import { sandboxService, workspaceService } from "../container.ts";
import { toolUrl } from "../orchestrators/tools/registry.ts";
import { resolveDevConfig } from "../schemas/index.ts";
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
      const devUrl = resolveDevConfig(workspace?.config)
        ? toolUrl("dev", sandbox.id)
        : undefined;

      return {
        baseDomain: config.domain.baseDomain,
        host: request.headers.get("host") ?? "",
        sandboxId: sandbox.id,
        routes: {
          ...sandbox.runtime.urls,
          dev: devUrl,
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
