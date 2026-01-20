import { node } from "@elysiajs/node";
import { Elysia } from "elysia";
import { AGENT_PORT } from "./constants";
import { appsRoutes } from "./routes/apps";
import { configRoutes } from "./routes/config";
import { execRoutes } from "./routes/exec";
import { gitRoutes } from "./routes/git";
import { healthRoutes } from "./routes/health";
import { servicesRoutes } from "./routes/services";
import { storageRoutes } from "./routes/storage";
import { vscodeRoutes } from "./routes/vscode";

const app = new Elysia({ adapter: node() })
  .use(healthRoutes)
  .use(configRoutes)
  .use(appsRoutes)
  .use(execRoutes)
  .use(servicesRoutes)
  .use(storageRoutes)
  .use(gitRoutes)
  .use(vscodeRoutes)
  .listen(AGENT_PORT, () => {
    console.log(`Sandbox agent running at http://0.0.0.0:${AGENT_PORT}`);
  });

export type App = typeof app;
