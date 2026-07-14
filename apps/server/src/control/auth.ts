/**
 * Authn mechanism — framework-agnostic (no Elysia). `api/` wires this into
 * the actual HTTP middleware; control only knows how to verify a token and
 * validate an API key.
 */
import * as jose from "jose";
import { UnauthorizedError } from "../shared/errors.ts";
import { config, isMock } from "../shared/lib/config.ts";
import type { ApiKeyService } from "./modules/api-key/index.ts";
import type { UserService } from "./modules/user/index.ts";

const JWT_SECRET = new TextEncoder().encode(config.auth.jwtSecret);

export interface AuthUser {
  id: string;
  username: string;
  avatarUrl: string;
  email: string;
}

const JWT_ISSUER_ALG = "HS256";

/** Sign a JWT for `user` (HS256, `@elysiajs/jwt`-compatible claims shape). */
export async function signJwt(
  user: AuthUser,
  expiresInSeconds = 7 * 24 * 60 * 60,
): Promise<string> {
  return new jose.SignJWT({
    username: user.username,
    avatarUrl: user.avatarUrl,
    email: user.email,
  })
    .setProtectedHeader({ alg: JWT_ISSUER_ALG })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    .sign(JWT_SECRET);
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
    if (!payload.sub || !payload.username) return null;
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

export class AuthService {
  constructor(
    private readonly deps: {
      apiKeyService: ApiKeyService;
      userService: UserService;
    },
  ) {}

  /** Resolve a token (JWT or `atl_`-prefixed API key) into an AuthUser. */
  async resolveToken(token: string | undefined): Promise<AuthUser> {
    if (!token) throw new UnauthorizedError();

    if (token.startsWith("atl_")) {
      const result = this.deps.apiKeyService.validateKey(token);
      if (!result) throw new UnauthorizedError("Invalid or expired API key");
      const dbUser = this.deps.userService.getById(result.userId);
      if (!dbUser) throw new UnauthorizedError("User not found for API key");
      return {
        id: dbUser.id,
        username: dbUser.username,
        avatarUrl: dbUser.avatarUrl ?? "",
        email: dbUser.email,
      };
    }

    const user = await verifyJwt(token);
    if (!user) throw new UnauthorizedError("Invalid or expired token");
    return user;
  }
}
