import {
  handleDeleteApp,
  handleGetApps,
  handlePostApps,
} from "./routes/apps.ts";
import { handleConfig, handleEditorConfig } from "./routes/config.ts";
import {
  handleDevLogs,
  handleDevStart,
  handleDevStop,
  handleGetDev,
} from "./routes/dev.ts";
import { handleExec, handleExecBatch } from "./routes/exec.ts";
import { handleHealth, handleMetrics } from "./routes/health.ts";

function json405(): Response {
  return Response.json({ error: "Method Not Allowed" }, { status: 405 });
}

function json404(): Response {
  return Response.json({ error: "Not Found" }, { status: 404 });
}

export async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/health") {
    return method === "GET" ? handleHealth() : json405();
  }
  if (pathname === "/metrics") {
    return method === "GET" ? handleMetrics() : json405();
  }

  if (pathname === "/exec") {
    return method === "POST" ? handleExec(request) : json405();
  }
  if (pathname === "/exec/batch") {
    return method === "POST" ? handleExecBatch(request) : json405();
  }

  if (pathname === "/config") {
    return method === "GET" ? handleConfig() : json405();
  }
  if (pathname === "/editor-config") {
    return method === "GET" ? handleEditorConfig() : json405();
  }
  if (pathname === "/apps") {
    if (method === "GET") return handleGetApps();
    if (method === "POST") return handlePostApps(request);
    return json405();
  }
  const appsMatch = pathname.match(/^\/apps\/(\d+)$/);
  if (appsMatch) {
    return method === "DELETE" ? handleDeleteApp(appsMatch[1]) : json405();
  }

  if (pathname === "/dev") {
    return method === "GET" ? handleGetDev() : json405();
  }
  const devStartMatch = pathname.match(/^\/dev\/([^/]+)\/start$/);
  if (devStartMatch) {
    return method === "POST"
      ? handleDevStart(decodeURIComponent(devStartMatch[1]), request)
      : json405();
  }
  const devStopMatch = pathname.match(/^\/dev\/([^/]+)\/stop$/);
  if (devStopMatch) {
    return method === "POST"
      ? handleDevStop(decodeURIComponent(devStopMatch[1]))
      : json405();
  }
  const devLogsMatch = pathname.match(/^\/dev\/([^/]+)\/logs$/);
  if (devLogsMatch) {
    return method === "GET"
      ? handleDevLogs(decodeURIComponent(devLogsMatch[1]), url)
      : json405();
  }

  return json404();
}
