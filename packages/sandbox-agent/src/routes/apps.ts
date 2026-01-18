import { Elysia } from "elysia";
import type { AppPort } from "../types";
import { AppRegistrationSchema } from "../types";

const registeredApps: AppPort[] = [];

export const appsRoutes = new Elysia()
  .get("/apps", () => registeredApps)
  .post(
    "/apps",
    ({ body }) => {
      const existing = registeredApps.find((a) => a.port === body.port);
      if (existing) {
        existing.name = body.name;
        return existing;
      }
      const app: AppPort = {
        port: body.port,
        name: body.name,
        registeredAt: new Date().toISOString(),
      };
      registeredApps.push(app);
      return app;
    },
    {
      body: AppRegistrationSchema,
    },
  )
  .delete("/apps/:port", ({ params }) => {
    const port = parseInt(params.port, 10);
    const index = registeredApps.findIndex((a) => a.port === port);
    if (index === -1) return { success: false };
    registeredApps.splice(index, 1);
    return { success: true };
  });
