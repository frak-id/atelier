/**
 * The Elysia binding around control's framework-agnostic `AuthService`. Kept
 * in `api/` (the HTTP shell) — control has no Elysia dependency by design.
 */

import { Elysia } from "elysia";
import type { AuthUser, ControlContainer } from "../control/index.ts";

export function createAuthPlugin(control: ControlContainer) {
  return new Elysia({ name: "auth-guard" })
    .resolve(async ({ cookie, headers }): Promise<{ user: AuthUser }> => {
      // biome-ignore lint/suspicious/noExplicitAny: Elysia cookie type is Cookie<unknown>
      let token = (cookie as Record<string, any>).sandbox_token?.value as
        | string
        | undefined;
      if (!token) {
        const authHeader = headers.authorization;
        if (authHeader?.startsWith("Bearer ")) token = authHeader.slice(7);
      }
      const user = await control.authService.resolveToken(token);
      return { user };
    })
    .as("scoped");
}
