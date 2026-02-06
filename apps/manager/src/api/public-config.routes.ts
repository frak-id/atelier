import { Elysia } from "elysia";
import { PublicConfigSchema } from "../schemas/public-config.ts";
import { config } from "../shared/lib/config.ts";

export const publicConfigRoutes = new Elysia().get(
  "/config",
  () => ({
    sshHostname: config.sshProxy.domain,
    sshPort: config.sshProxy.port,
    opencodePort: config.services.opencode.port,
  }),
  {
    response: PublicConfigSchema,
    detail: {
      tags: ["config"],
      description: "Public configuration for the dashboard",
    },
  },
);
