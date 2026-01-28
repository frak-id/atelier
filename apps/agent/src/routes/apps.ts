import type { AppPort } from "../types.ts";

const registeredApps: AppPort[] = [];

export function handleGetApps(): Response {
  return Response.json(registeredApps);
}

export async function handlePostApps(request: Request): Promise<Response> {
  const body = await request.json();
  const existing = registeredApps.find((a) => a.port === body.port);
  if (existing) {
    existing.name = body.name;
    return Response.json(existing);
  }
  const app: AppPort = {
    port: body.port,
    name: body.name,
    registeredAt: new Date().toISOString(),
  };
  registeredApps.push(app);
  return Response.json(app);
}

export function handleDeleteApp(port: string): Response {
  const portNum = parseInt(port, 10);
  const index = registeredApps.findIndex((a) => a.port === portNum);
  if (index === -1) return Response.json({ success: false });
  registeredApps.splice(index, 1);
  return Response.json({ success: true });
}
