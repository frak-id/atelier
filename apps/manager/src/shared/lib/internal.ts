import type { Sandbox } from "../../schemas/index.ts";
import { config, isMock } from "./config.ts";

type RequestIPInfo = { address: string };
type RequestIPServer = { requestIP?: (request: Request) => unknown };

export function getRequestIp(
  request: Request,
  server: unknown,
): string | undefined {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const s = server as RequestIPServer;
  const info = s.requestIP?.(request);
  if (typeof info !== "object" || info === null) return undefined;
  const ipInfo = info as RequestIPInfo;
  return typeof ipInfo.address === "string" ? ipInfo.address : undefined;
}

export function createInternalGuard(getSandboxes: () => Sandbox[]) {
  return ({
    request,
    server,
    set,
  }: {
    request: Request;
    server: unknown;
    set: { status?: number | string };
  }) => {
    if (isMock()) return;

    const ip = getRequestIp(request, server);
    if (!ip) {
      set.status = 403;
      return {
        baseDomain: config.domain.baseDomain,
        host: request.headers.get("host") ?? "",
      };
    }

    const sandboxes = getSandboxes();
    const isSandboxIp = sandboxes.some((s) => s.runtime.ipAddress === ip);
    if (!isSandboxIp) {
      set.status = 403;
      return {
        baseDomain: config.domain.baseDomain,
        host: request.headers.get("host") ?? "",
      };
    }
  };
}
