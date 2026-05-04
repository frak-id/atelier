import { Elysia } from "elysia";
import { sandboxSpawner, workspaceService } from "../container.ts";
import {
  OpencodeSpawnBodySchema,
  OpencodeSpawnResponseSchema,
} from "../schemas/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("opencode-routes");

export const opencodeRoutes = new Elysia({ prefix: "/opencode" }).post(
  "/spawn",
  async ({ body }) => {
    const match = workspaceService.matchByRemoteUrl(body.remoteUrl);
    if (!match) {
      throw new NotFoundError("Workspace matching remote URL", body.remoteUrl);
    }

    const { workspace } = match;
    log.info(
      { workspaceId: workspace.id, remoteUrl: body.remoteUrl },
      "Spawning sandbox from OpenCode request",
    );

    // sandboxSpawner.spawn returns only after the workflow has waited for
    // both the agent and OpenCode to be ready.
    const sandbox = await sandboxSpawner.spawn({ workspaceId: workspace.id });

    return {
      sandboxId: sandbox.id,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      opencodeUrl: sandbox.runtime.urls.opencode,
      password: sandbox.runtime.opencodePassword,
    };
  },
  {
    body: OpencodeSpawnBodySchema,
    response: OpencodeSpawnResponseSchema,
  },
);
