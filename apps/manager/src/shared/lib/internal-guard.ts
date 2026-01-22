import { NETWORK } from "@frak-sandbox/shared/constants";

const ALLOWED_SUBNET = NETWORK.GUEST_SUBNET;

interface ServerWithRequestIP {
  requestIP(request: Request): { address: string; port: number } | null;
}

function getClientIp(
  request: Request,
  server: ServerWithRequestIP | null,
): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? null;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  if (server) {
    const socketAddr = server.requestIP(request);
    if (socketAddr?.address) {
      return socketAddr.address;
    }
  }

  return null;
}

export async function internalGuard({
  request,
  server,
  set,
}: {
  request: Request;
  server: ServerWithRequestIP | null;
  set: { status?: number | string };
}): Promise<{ error: string; message: string } | void> {
  const clientIp = getClientIp(request, server);

  if (!clientIp) {
    set.status = 403;
    return {
      error: "FORBIDDEN",
      message: "Unable to determine client IP",
    };
  }

  if (!clientIp.startsWith(ALLOWED_SUBNET)) {
    set.status = 403;
    return {
      error: "FORBIDDEN",
      message: "Internal API access restricted to sandbox network",
    };
  }
}
