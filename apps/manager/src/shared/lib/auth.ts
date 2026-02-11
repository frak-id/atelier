import * as jose from "jose";
import { config, isMock } from "./config.ts";

const JWT_SECRET = new TextEncoder().encode(config.auth.jwtSecret);

export interface AuthUser {
  id: string;
  username: string;
  avatarUrl: string;
}

export async function verifyJwt(token: string): Promise<AuthUser | null> {
  if (isMock()) {
    return {
        id: "12345",
        username: "mock-user",
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    };
  }

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
  cookie,
  set,
  store,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: Elysia cookie type is Cookie<unknown>
  cookie: Record<string, any>;
  set: { status?: number | string };
  store: { user?: AuthUser } & Record<string, unknown>;
}): Promise<{ error: string; message: string } | undefined> {
  const token = cookie.sandbox_token?.value as string | undefined;
  if (!token || typeof token !== "string") {
    set.status = 401;
    return {
      error: "UNAUTHORIZED",
      message: "Missing authentication",
    };
  }

  const user = await verifyJwt(token);
  if (!user) {
    set.status = 401;
    return {
      error: "UNAUTHORIZED",
      message: "Invalid or expired token",
    };
  }

  store.user = user;
}
