import { Elysia } from "elysia";
import * as jose from "jose";
import { UnauthorizedError } from "../errors.ts";
import { config, isMock } from "./config.ts";

const JWT_SECRET = new TextEncoder().encode(config.auth.jwtSecret);

export interface AuthUser {
  id: string;
  username: string;
  avatarUrl: string;
  email: string;
}

export async function verifyJwt(token: string): Promise<AuthUser | null> {
  if (isMock()) {
    return {
      id: "12345",
      username: "mock-user",
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      email: "12345+mock-user@users.noreply.github.com",
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
      email: (payload.email as string) || "",
    };
  } catch {
    return null;
  }
}

export const authPlugin = new Elysia({ name: "auth-guard" })
  .resolve(async ({ cookie, headers }) => {
    // biome-ignore lint/suspicious/noExplicitAny: Elysia cookie type is Cookie<unknown>
    let token = (cookie as Record<string, any>).sandbox_token?.value as
      | string
      | undefined;

    if (!token) {
      const authHeader = headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.slice(7);
      }
    }

    if (!token || typeof token !== "string") {
      throw new UnauthorizedError();
    }

    const user = await verifyJwt(token);
    if (!user) {
      throw new UnauthorizedError("Invalid or expired token");
    }

    return { user };
  })
  .as("scoped");
