/**
 * Forward-auth for sandbox tool URLs (`ports[].auth: "forward"`: pi-web,
 * code-server, the browser). The ingress controller (a Traefik `forwardAuth`
 * middleware, infra/k8s/80-forward-auth.yaml) asks `GET /auth/forward`
 * before every request to such a URL, passing the original request's
 * headers (its cookies) plus `X-Forwarded-Proto/Host/Uri/Method`. A 2xx lets
 * the request through; anything else is returned to the caller as is.
 *
 * The rule is "signed in to Atelier": the console's `sandbox_token` session
 * cookie, scoped to the base domain, so every tool host receives it. Login
 * already requires membership of the allowed GitHub org. A browser landing
 * on a tool URL without a session is sent through the GitHub login and back.
 */

/** The `X-Forwarded-*` headers the ingress sets on the auth subrequest. */
export interface ForwardedRequest {
  proto?: string;
  host?: string;
  uri?: string;
  method?: string;
  accept?: string;
}

export type ForwardAuthDecision =
  | { status: 200 }
  | { status: 302; location: string }
  | { status: 401 };

/** Whether `url` may be redirected to after login: a sandbox tool URL or
 * the console, i.e. the base domain or one of its subdomains, over https
 * (http only outside production). Anything else would be an open redirect. */
export function isReturnUrl(
  url: string,
  baseDomain: string,
  allowHttp: boolean,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" &&
    !(allowHttp && parsed.protocol === "http:")
  ) {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  const domain = baseDomain.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

/** The URL the original request was for, rebuilt from the forwarded headers. */
export function forwardedUrl(req: ForwardedRequest): string | undefined {
  if (!req.host) return undefined;
  const proto = req.proto === "http" ? "http" : "https";
  const uri = req.uri?.startsWith("/") ? req.uri : "/";
  return `${proto}://${req.host}${uri}`;
}

/**
 * Let a signed-in caller through; send a browser page load without a session
 * to the login (which returns to the original URL); refuse the rest (API
 * calls, websockets, assets) with a 401 rather than a login page they can't
 * render.
 */
export function decideForwardAuth(input: {
  signedIn: boolean;
  forwarded: ForwardedRequest;
  /** The login entry point, e.g. `https://console/auth/github`. */
  loginUrl: string;
  baseDomain: string;
  allowHttp: boolean;
}): ForwardAuthDecision {
  if (input.signedIn) return { status: 200 };
  const { forwarded } = input;
  const method = (forwarded.method ?? "GET").toUpperCase();
  const wantsPage = forwarded.accept?.includes("text/html") ?? false;
  const target = forwardedUrl(forwarded);
  if (
    method === "GET" &&
    wantsPage &&
    target &&
    isReturnUrl(target, input.baseDomain, input.allowHttp)
  ) {
    const sep = input.loginUrl.includes("?") ? "&" : "?";
    return {
      status: 302,
      location: `${input.loginUrl}${sep}return_to=${encodeURIComponent(target)}`,
    };
  }
  return { status: 401 };
}

// ── auto-resume on access ────────────────────────────────────────────────

/** How long a client should wait before retrying a request answered 503
 * while its sandbox wakes up. */
export const WAKE_RETRY_AFTER_SECONDS = 5;

/**
 * The sandbox a tool URL belongs to. Tool hosts are `{name}-{id}.{baseDomain}`
 * (`toolHost`, runtime/kube); sandbox ids are lowercase alphanumerics, so the
 * id is what follows the last dash of the first label. `undefined` for any
 * other host (the console, an unrelated domain).
 */
export function sandboxIdFromHost(
  host: string | undefined,
  baseDomain: string,
): string | undefined {
  if (!host) return undefined;
  const lower = host.toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!lower.endsWith(suffix)) return undefined;
  const label = lower.slice(0, -suffix.length);
  if (label.includes(".")) return undefined;
  const dash = label.lastIndexOf("-");
  const id = dash > 0 ? label.slice(dash + 1) : "";
  return /^[a-z0-9]+$/.test(id) ? id : undefined;
}

/** Whether `host` (any case, with or without a port) is one of the
 * sandbox's `previewHosts`: the only hosts the unauthenticated wake check
 * answers for. */
export function isPreviewHost(
  host: string | undefined,
  previewHosts: string[] | undefined,
): boolean {
  if (!host || !previewHosts) return false;
  const lower = host.toLowerCase().replace(/:\d+$/, "");
  return previewHosts.some((h) => h.toLowerCase() === lower);
}

export type WakeDecision =
  /** Let the request through (the sandbox is up, or not ours to wake). */
  | { status: 200 }
  /** The sandbox is paused: a resume is under way. `page` is whether the
   * client is a browser page load, which gets the auto-refreshing page
   * instead of a bare 503 + `Retry-After`. */
  | { status: 503; page: boolean };

/** Only a `paused` sandbox auto-resumes: an `error` one needs a person
 * (resuming it again would loop on whatever broke it). */
export function decideWake(
  status: string | undefined,
  forwarded: ForwardedRequest,
): WakeDecision {
  if (status !== "paused") return { status: 200 };
  const method = (forwarded.method ?? "GET").toUpperCase();
  const page =
    method === "GET" && (forwarded.accept?.includes("text/html") ?? false);
  return { status: 503, page };
}

/** The tiny page a browser sees while its sandbox wakes: it reloads itself
 * (through the same forward-auth check) until the sandbox answers. */
export function wakePage(): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="refresh" content="${WAKE_RETRY_AFTER_SECONDS}">` +
    `<title>Waking up sandbox…</title>` +
    `<style>body{font:16px system-ui;display:grid;place-items:center;` +
    `height:100vh;margin:0;color:#444}</style></head>` +
    `<body><p>Waking up sandbox… this page reloads on its own.</p></body></html>`
  );
}
