import * as jose from "jose";
import { config } from "./config.ts";

const JWT_SECRET = new TextEncoder().encode(config.auth.jwtSecret);

export interface AuthUser {
  id: string;
  username: string;
  avatarUrl: string;
}

async function verifyJwt(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET);
    if (!payload.sub || !payload.username) {
      return null;
    }
    return {
      id: payload.sub,
      username: payload.username as string,
      avatarUrl: (payload.avatarUrl as string) || "",
    };
  } catch {
    return null;
  }
}

export async function authGuard({
  headers,
  set,
}: {
  headers: Record<string, string | undefined>;
  set: { status?: number | string };
}): Promise<{ error: string; message: string } | void> {
  const authHeader = headers.authorization;
  if (!authHeader) {
    set.status = 401;
    return {
      error: "UNAUTHORIZED",
      message: "Missing authorization header",
    };
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    set.status = 401;
    return {
      error: "UNAUTHORIZED",
      message: "Invalid authorization format",
    };
  }

  const user = await verifyJwt(match[1]);
  if (!user) {
    set.status = 401;
    return {
      error: "UNAUTHORIZED",
      message: "Invalid or expired token",
    };
  }
}
