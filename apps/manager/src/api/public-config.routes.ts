import { Elysia } from "elysia";
import { PublicConfigSchema } from "../schemas/public-config.ts";
import { config } from "../shared/lib/config.ts";

export const publicConfigRoutes = new Elysia().get(
  "/config",
  () => {
    const baseDomain = config.domain.baseDomain;
    const protocol = baseDomain === "localhost" ? "http" : "https";
    const dashboard = config.domain.dashboard;
    const mcpUrl = `${protocol}://${dashboard}/mcp`;

    return {
      sshHostname: config.domain.ssh.hostname,
      sshPort: config.domain.ssh.port,
      opencodePort: config.ports.opencode,
      mcp: {
        url: mcpUrl,
        hasToken: !!config.server.mcpToken,
      },
    };
  },
  {
    response: PublicConfigSchema,
    detail: {
      tags: ["config"],
      description: "Public configuration for the dashboard",
    },
  },
);
