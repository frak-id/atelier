/**
 * Authn mechanism — framework-agnostic (no Elysia). `api/` wires this into
 * the actual HTTP middleware; control only knows how to verify a token and
 * validate an API key.
 */
import * as jose from "jose";
import { ForbiddenError, UnauthorizedError } from "../shared/errors.ts";
import { config, isAuthBypassed } from "../shared/lib/config.ts";
import type { ApiKeyService } from "./modules/api-key/index.ts";
import type { UserService } from "./modules/user/index.ts";
import type { ApiKeyScope, UserKind } from "./types.ts";

const JWT_SECRET = new TextEncoder().encode(config.auth.jwtSecret);

export interface AuthUser {
  id: string;
  username: string;
  avatarUrl: string;
  email: string;
  /** A service account never has a JWT (it has no console login). */
  kind: UserKind;
  /** The key's scope; a JWT is always `full`. */
  scope: ApiKeyScope;
}

/** The claim fields of a JWT: it only ever carries a human, with full scope. */
export type JwtClaims = Pick<
  AuthUser,
  "id" | "username" | "avatarUrl" | "email"
>;

/** Where a token is presented: an `mcp`-scoped key only passes on `mcp`. */
export type AuthSurface = "http" | "mcp" | "mcp-admin";

/** Service-account ids (`sa_…`) never clash with a GitHub id; a JWT whose
 * subject is one is refused even if it verifies. */
const SERVICE_ACCOUNT_ID_PREFIX = "sa_";

const JWT_ISSUER_ALG = "HS256";

/** Sign a JWT for `user` (HS256, `@elysiajs/jwt`-compatible claims shape). */
export async function signJwt(
  user: JwtClaims,
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
  if (isAuthBypassed()) {
    return {
      id: "12345",
      username: "mock-user",
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      email: "12345+mock-user@users.noreply.github.com",
      kind: "human",
      scope: "full",
    };
  }
  try {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET);
    if (!payload.sub || !payload.username) return null;
    if (payload.sub.startsWith(SERVICE_ACCOUNT_ID_PREFIX)) return null;
    return {
      id: payload.sub,
      username: payload.username as string,
      avatarUrl: (payload.avatarUrl as string) || "",
      email: (payload.email as string) || "",
      kind: "human",
      scope: "full",
    };
  } catch {
    return null;
  }
}

export class AuthService {
  constructor(
    private readonly deps: {
      apiKeyService: ApiKeyService;
      userService: Pick<UserService, "getById">;
    },
  ) {}

  /**
   * The person behind a console session JWT, or null. A session lives only
   * while Atelier holds the person's GitHub token: a login always stores one,
   * and a token GitHub rejected is dropped (`GitHubTokenValidator`), which
   * ends every session of theirs until they sign in again. A JWT whose
   * subject is a service account is never a session.
   */
  async verifySession(token: string): Promise<AuthUser | null> {
    const user = await verifyJwt(token);
    if (!user || isAuthBypassed()) return user;
    const stored = this.deps.userService.getById(user.id);
    if (stored?.kind !== "human" || !stored.githubAccessToken) return null;
    return user;
  }

  /**
   * Resolve a token (JWT or `atl_`-prefixed API key) into an AuthUser.
   * `surface` is where it was presented: an `mcp`-scoped key is refused
   * (403) everywhere but the sandbox MCP.
   */
  async resolveToken(
    token: string | undefined,
    surface: AuthSurface = "http",
  ): Promise<AuthUser> {
    if (!token) throw new UnauthorizedError();

    if (token.startsWith("atl_")) {
      const result = this.deps.apiKeyService.validateKey(token);
      if (!result) throw new UnauthorizedError("Invalid or expired API key");
      const dbUser = this.deps.userService.getById(result.userId);
      if (!dbUser) throw new UnauthorizedError("User not found for API key");
      if (result.scope === "mcp" && surface !== "mcp") {
        throw new ForbiddenError(
          "This API key only works on the sandbox MCP (/mcp)",
        );
      }
      return {
        id: dbUser.id,
        username: dbUser.username,
        avatarUrl: dbUser.avatarUrl ?? "",
        email: dbUser.email,
        kind: dbUser.kind,
        scope: result.scope,
      };
    }

    const user = await this.verifySession(token);
    if (!user) throw new UnauthorizedError("Invalid or expired token");
    return user;
  }
}
