/**
 * Launchpad tools — the MCP mirror of `/api/launchpad/*`
 * (docs/proposals/launchpad.md): the non-technical surface over Atelier, for
 * an agent acting on behalf of a non-technical user. A starter is a curated
 * recipe (a dev team's "spin up a sandbox that does X"); launching one gives
 * the user a **workspace** with its own title and a set of service tiles
 * (a web app, an admin panel, the assistant's UI). Shares the exact
 * `LaunchpadLifecycle` wiring `/api/launchpad` uses (`createLaunchpadLifecycle`)
 * so authorization and phase derivation are identical on both surfaces.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthUser } from "../../../control/index.ts";
import type { ServerContainer } from "../../container.ts";
import {
  createLaunchpadLifecycle,
  type WorkspaceView,
} from "../../launchpad.lifecycle.ts";
import { safeTool, text } from "../format.ts";

/** Where a non-technical user (or the agent, on their behalf) can watch a
 * workspace boot and open its tiles. The server has no configured public
 * origin to prefix this with, so it's a path relative to the console. */
function consolePath(workspaceId: string): string {
  return `/launchpad/w/${workspaceId}`;
}

function formatView(view: WorkspaceView) {
  return {
    id: view.id,
    title: view.title,
    phase: view.phase,
    starter: view.starterTitle,
    ...(view.error ? { error: view.error } : {}),
    console: consolePath(view.id),
  };
}

export function registerLaunchpadTools(
  server: McpServer,
  container: ServerContainer,
  user: AuthUser,
): void {
  const lifecycle = createLaunchpadLifecycle(container);

  server.registerTool(
    "launchpad_catalog",
    {
      title: "Browse Launchpad starters",
      description:
        "List the starters the user can launch into a new workspace — " +
        "curated recipes like 'a website to edit' or 'a research " +
        "assistant', each with its title, a plain-language description, " +
        "and the tools/services it comes with. Use this to find a starter " +
        "before calling launchpad_launch.",
      inputSchema: {},
    },
    safeTool(async () =>
      text(
        lifecycle.catalog(user.id).map((starter) => ({
          id: starter.id,
          title: starter.title,
          description: starter.description,
          services: starter.services,
        })),
      ),
    ),
  );

  server.registerTool(
    "launchpad_launch",
    {
      title: "Launch a Launchpad starter",
      description:
        "Launch a starter into a new workspace for the user. Returns right " +
        "away with the new workspace's id and phase — it takes a little " +
        "while to finish booting; check back with launchpad_workspace or " +
        "launchpad_workspaces. Use launchpad_catalog first to find the " +
        "starter id.",
      inputSchema: {
        starterId: z.string().describe("A starter id from launchpad_catalog"),
        title: z
          .string()
          .max(120)
          .optional()
          .describe("A name for the workspace; defaults to the starter's"),
        description: z.string().max(1000).optional(),
      },
    },
    safeTool(async ({ starterId, title, description }) => {
      const view = lifecycle.launch(user, starterId, {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      return text(formatView(view));
    }),
  );

  server.registerTool(
    "launchpad_workspaces",
    {
      title: "List the user's workspaces",
      description:
        "List every workspace the user has launched, with its current " +
        "phase (preparing, starting, ready, sleeping, or failed) and which " +
        "starter it came from. Use this to see what the user already has " +
        "running before launching something new.",
      inputSchema: {},
    },
    safeTool(async () => text(lifecycle.list(user.id).map(formatView))),
  );

  server.registerTool(
    "launchpad_workspace",
    {
      title: "Get workspace details",
      description:
        "Get one workspace's full detail: its phase in plain words, the " +
        "how-to guide (if the starter has one), and every service tile " +
        "with its live URL (a tile with no URL isn't exposed yet — the " +
        "workspace may still be starting). Use this to report status and " +
        "hand the user a link once it's ready.",
      inputSchema: {
        workspaceId: z.string(),
      },
    },
    safeTool(async ({ workspaceId }) => {
      const detail = await lifecycle.detail(workspaceId, user.id);
      return text({
        ...formatView(detail),
        ...(detail.guide ? { guide: detail.guide } : {}),
        services: detail.services,
      });
    }),
  );

  server.registerTool(
    "launchpad_workspace_action",
    {
      title: "Sleep, wake, or retry a workspace",
      description:
        "Put a ready workspace to sleep (frees its compute, keeps its " +
        "data), wake a sleeping one back up, or retry one that failed to " +
        "launch or wake up. Deleting a workspace is not available here — " +
        "that stays on the console, since it's destructive.",
      inputSchema: {
        workspaceId: z.string(),
        action: z.enum(["sleep", "wake", "retry"]),
      },
    },
    safeTool(async ({ workspaceId, action }) => {
      switch (action) {
        case "sleep":
          return text(formatView(await lifecycle.sleep(workspaceId, user.id)));
        case "wake":
          return text(formatView(lifecycle.wake(workspaceId, user.id)));
        case "retry":
          return text(formatView(lifecycle.retry(user, workspaceId)));
      }
    }),
  );
}
