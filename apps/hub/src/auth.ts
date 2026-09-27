/**
 * Bearer-token auth. Tokens are opaque `hub_…` strings; the config stores
 * their sha256, so lookup is a hash + map hit and a leaked config file
 * grants nothing.
 */
import type { Actor } from "@atelier/knowledge";
import type { HubScope, TokenConfig } from "./config.ts";

export interface Caller {
  token: string;
  actor: Actor;
  scopes: ReadonlySet<HubScope>;
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function hashToken(raw: string): string {
  return new Bun.CryptoHasher("sha256").update(raw).digest("hex");
}

/** A new random token and the hash to put in the config. */
export function mintToken(): { token: string; sha256: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = `hub_${Buffer.from(bytes).toString("base64url")}`;
  return { token, sha256: hashToken(token) };
}

export class TokenAuth {
  private readonly byHash = new Map<string, TokenConfig>();

  constructor(tokens: TokenConfig[]) {
    for (const t of tokens) this.byHash.set(t.sha256, t);
  }

  /** Resolves an `Authorization` header value (with or without `Bearer`). */
  authenticate(header: string | null | undefined): Caller {
    const raw = header?.replace(/^Bearer\s+/i, "").trim();
    if (!raw) throw new AuthError(401, "missing bearer token");
    const config = this.byHash.get(hashToken(raw));
    if (!config) throw new AuthError(401, "invalid token");
    return {
      token: config.name,
      actor: config.actor,
      scopes: new Set(config.scopes),
    };
  }
}

export function requireScope(caller: Caller, scope: HubScope): void {
  if (!caller.scopes.has(scope)) {
    throw new AuthError(403, `token ${caller.token} lacks scope ${scope}`);
  }
}
