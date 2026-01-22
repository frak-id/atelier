import { NETWORK } from "@frak-sandbox/shared/constants";

const ALLOWED_SUBNET = NETWORK.GUEST_SUBNET;

function getClientIp(request: Request): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? null;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  return null;
}

export async function internalGuard({
  request,
  set,
}: {
  request: Request;
  set: { status?: number | string };
}): Promise<{ error: string; message: string } | void> {
  const clientIp = getClientIp(request);

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
