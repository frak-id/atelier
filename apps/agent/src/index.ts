import { node } from "@elysiajs/node";
import { Elysia } from "elysia";
import { AGENT_PORT } from "./constants";
import { appsRoutes } from "./routes/apps";
import { configRoutes } from "./routes/config";
import { devRoutes } from "./routes/dev";
import { execRoutes } from "./routes/exec";
import { gitRoutes } from "./routes/git";
import { healthRoutes } from "./routes/health";
import { servicesRoutes } from "./routes/services";
import { storageRoutes } from "./routes/storage";
import { vscodeRoutes } from "./routes/vscode";
import { authSyncService } from "./services/auth-sync";

const app = new Elysia({ adapter: node() })
  .use(healthRoutes)
  .use(configRoutes)
  .use(appsRoutes)
  .use(devRoutes)
  .use(execRoutes)
  .use(servicesRoutes)
  .use(storageRoutes)
  .use(gitRoutes)
  .use(vscodeRoutes)
  .listen(AGENT_PORT, () => {
    console.log(`Sandbox agent running at http://0.0.0.0:${AGENT_PORT}`);
    authSyncService.start().catch((err) => {
      console.error("Failed to start auth sync service:", err);
    });
  });

export type App = typeof app;
