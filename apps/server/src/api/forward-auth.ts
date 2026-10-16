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
