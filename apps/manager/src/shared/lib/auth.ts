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

// Minimal interfaces to avoid circular import with container.ts
interface IApiKeyService {
  validateKey(rawKey: string): { userId: string; apiKeyId: string } | null;
}

interface IUserService {
  getById(id: string):
    | {
        id: string;
        username: string;
        avatarUrl?: string | null | undefined;
        email: string;
      }
    | undefined;
}

let _apiKeyService: IApiKeyService | null = null;
let _userService: IUserService | null = null;

export function initAuthDependencies(deps: {
  apiKeyService: IApiKeyService;
  userService: IUserService;
}): void {
  _apiKeyService = deps.apiKeyService;
  _userService = deps.userService;
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

    // API key path: tokens prefixed with "atl_"
    if (token.startsWith("atl_")) {
      if (!_apiKeyService || !_userService) {
        throw new UnauthorizedError("API key auth not initialized");
      }
      const result = _apiKeyService.validateKey(token);
      if (!result) {
        throw new UnauthorizedError("Invalid or expired API key");
      }
      const dbUser = _userService.getById(result.userId);
      if (!dbUser) {
        throw new UnauthorizedError("User not found for API key");
      }
      const user: AuthUser = {
        id: dbUser.id,
        username: dbUser.username,
        avatarUrl: dbUser.avatarUrl ?? "",
        email: dbUser.email,
      };
      return { user };
    }

    // JWT path
    const user = await verifyJwt(token);
    if (!user) {
      throw new UnauthorizedError("Invalid or expired token");
    }

    return { user };
  })
  .as("scoped");
