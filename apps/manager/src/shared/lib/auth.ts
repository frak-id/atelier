import { Elysia } from "elysia";

/**
 * Pre-computed SHA-256 hashes of base64-encoded credentials.
 * To add a user: echo -n "username:password" | base64 | xargs -I{} sh -c 'echo -n "{}" | shasum -a 256'
 */
const VALID_TOKEN_HASHES = new Set([
  // srod
  "3e81f76a3074652904c2b044c75c23000f49cd17b091635569b92674094bfa15",
  // konfeature
  "ef126911edbc6e1581e9b8e1958bcf250b9e5086037c3fa1d97dff072137bc69",
  // matt
  "2e86c0ea32486c73f636f9b20f1aca67cda533f88d71323fcedec81259bef90c",
]);

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function validateToken(authHeader: string | null): Promise<boolean> {
  if (!authHeader) return false;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) return false;

  const tokenHash = await hashToken(match[1]);
  return VALID_TOKEN_HASHES.has(tokenHash);
}

export const authMiddleware = new Elysia({ name: "auth" }).onBeforeHandle(
  async ({ headers, set, path }) => {
    if (path === "/swagger" || path.startsWith("/swagger/")) {
      return;
    }

    const isValid = await validateToken(headers.authorization ?? null);

    if (!isValid) {
      set.status = 401;
      return {
        error: "UNAUTHORIZED",
        message: "Invalid or missing authentication token",
      };
    }
  },
);
