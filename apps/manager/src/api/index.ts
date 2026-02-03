// API Routes - HTTP layer separated from business logic
// All routes import from container.ts, breaking circular dependencies

export { authRoutes } from "./auth.routes.ts";
export { configFileRoutes } from "./config-file.routes.ts";
export { eventsRoutes } from "./events.routes.ts";
export { gitSourceRoutes } from "./git-source.routes.ts";
export { githubApiRoutes, githubOAuthRoutes } from "./github-api.routes.ts";
export { healthRoutes } from "./health.routes.ts";
export { imageRoutes } from "./image.routes.ts";
export { publicConfigRoutes } from "./public-config.routes.ts";
export { registryRoutes } from "./registry.routes.ts";
export { sandboxRoutes } from "./sandbox.routes.ts";
export { sessionTemplateRoutes } from "./session-template.routes.ts";
export { sharedAuthRoutes } from "./shared-auth.routes.ts";
export { sharedStorageRoutes } from "./shared-storage.routes.ts";
export { sshKeyRoutes } from "./ssh-key.routes.ts";
export { systemRoutes } from "./system.routes.ts";
export { taskRoutes } from "./task.routes.ts";
export { workspaceRoutes } from "./workspace.routes.ts";
