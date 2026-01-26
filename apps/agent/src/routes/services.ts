import { Elysia } from "elysia";
import { getServiceLogs, getServiceStatus } from "../utils/service";

export const servicesRoutes = new Elysia()
  .get("/services", async () => {
    const [codeServer, opencode, sshd, ttyd] = await Promise.all([
      getServiceStatus("code-server"),
      getServiceStatus("opencode"),
      getServiceStatus("sshd"),
      getServiceStatus("ttyd"),
    ]);
    return { services: [codeServer, opencode, sshd, ttyd] };
  })
  .get("/logs/:service", async ({ params, query }) => {
    const lines = query.lines ? parseInt(query.lines, 10) : 100;
    const content = await getServiceLogs(params.service, lines);
    return { service: params.service, content };
  });
