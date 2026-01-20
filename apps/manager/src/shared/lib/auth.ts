/**
 * Pre-computed SHA-256 hashes of base64-encoded credentials.
 * To add a user: echo -n "$(echo -n 'username:password' | base64)" | shasum -a 256
 */
const VALID_TOKEN_HASHES = new Set([
  // srod
  "f6d4789a7283759a5fe41e0ccd2915b3c69ff30250d7e39122c1f3909b462187",
  // konfeature
  "abea2dc18ef66ab4c07b7c224edf0be2902eb5378ee69473fa03d10588376249",
  // matt
  "072fd3599d6b7ba686727b29733c181013ce52a3b794717500b246128ac4494e",
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

export async function authGuard({
  headers,
  set,
}: {
  headers: Record<string, string | undefined>;
  set: { status?: number | string };
}): Promise<{ error: string; message: string } | void> {
  const isValid = await validateToken(headers.authorization ?? null);

  if (!isValid) {
    set.status = 401;
    return {
      error: "UNAUTHORIZED",
      message: "Invalid or missing authentication token",
    };
  }
}
