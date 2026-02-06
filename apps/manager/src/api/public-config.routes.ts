import { Elysia } from "elysia";
import { PublicConfigSchema } from "../schemas/public-config.ts";
import { config } from "../shared/lib/config.ts";

export const publicConfigRoutes = new Elysia().get(
  "/config",
  () => ({
    sshHostname: config.domain.ssh.hostname,
    sshPort: config.domain.ssh.port,
    opencodePort: config.advanced.vm.opencode.port,
  }),
  {
    response: PublicConfigSchema,
    detail: {
      tags: ["config"],
      description: "Public configuration for the dashboard",
    },
  },
);
