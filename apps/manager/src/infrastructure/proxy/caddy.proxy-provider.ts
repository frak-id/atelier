import { Mutex } from "async-mutex";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type {
  ProxyProvider,
  ProxyProviderConfig,
  RouteConfig,
} from "./proxy.provider.ts";

const log = createChildLogger("proxy:caddy");

interface CaddyRoute {
  "@id"?: string;
  match?: Array<{ host?: string[] }>;
  handle?: unknown[];
  terminal?: boolean;
}

const ROUTES_PATH = "/config/apps/http/servers/srv0/routes";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ["{http.request.header.Origin}"],
  "Access-Control-Allow-Credentials": ["true"],
  Vary: ["Origin"],
} as const;
/**
 * CORS preflight subroute — handles OPTIONS with full CORS headers.
 * Extracted to avoid duplicating this block in every route builder.
 */
function buildCorsPreflightSubroute(): Record<string, unknown> {
  return {
    handle: [
      {
        handler: "headers",
        response: {
          set: {
            ...CORS_HEADERS,
            "Access-Control-Allow-Methods": [
              "GET, POST, PUT, DELETE, PATCH, OPTIONS",
            ],
            "Access-Control-Allow-Headers": [
              "{http.request.header.Access-Control-Request-Headers}",
            ],
            "Access-Control-Max-Age": ["600"],
          },
        },
      },
    ],
    match: [{ method: ["OPTIONS"] }],
    terminal: true,
  };
}

/**
 * Reverse proxy handler for an upstream with CORS response headers and streaming.
 */
function buildUpstreamHandler(
  upstream: string,
): Record<string, unknown> {
  return {
    handler: "reverse_proxy",
    upstreams: [{ dial: upstream }],
    transport: { protocol: "http", read_buffer_size: 4096 },
    headers: { response: { set: { ...CORS_HEADERS } } },
    flush_interval: -1,
  };
}

/**
 * Wraps subroutes in a host-matched CaddyRoute.
 */
function wrapInHostRoute(
  domain: string,
  subroutes: Record<string, unknown>[],
): CaddyRoute {
  return {
    "@id": domain,
    match: [{ host: [domain] }],
    handle: [{ handler: "subroute", routes: subroutes }],
    terminal: true,
  };
}

function routeId(route: CaddyRoute): string | undefined {
  return route["@id"];
}

function isWildcardRoute(route: CaddyRoute): boolean {
  return route.match?.[0]?.host?.some((host) => host.startsWith("*.")) ?? false;
}

function buildForwardAuthHandler(
  managerAddress: string,
): Record<string, unknown> {
  return {
    handler: "reverse_proxy",
    upstreams: [{ dial: managerAddress }],
    rewrite: { method: "GET", uri: "/auth/verify" },
    headers: {
      request: {
        set: {
          "X-Forwarded-Method": ["{http.request.method}"],
          "X-Forwarded-Uri": ["{http.request.uri}"],
        },
      },
    },
    handle_response: [
      {
        match: { status_code: [2] },
        routes: [
          {
            handle: [{ handler: "headers", request: { set: {} } }],
          },
        ],
      },
    ],
  };
}

function buildOpenCodeForwardAuthHandler(
  managerAddress: string,
): Record<string, unknown> {
  return {
    handler: "reverse_proxy",
    upstreams: [{ dial: managerAddress }],
    rewrite: { method: "GET", uri: "/auth/opencode/verify" },
    headers: {
      request: {
        set: {
          "X-Forwarded-Method": ["{http.request.method}"],
          "X-Forwarded-Uri": ["{http.request.uri}"],
          "X-Forwarded-Host": ["{http.request.host}"],
        },
      },
    },
    handle_response: [
      {
        match: { status_code: [2] },
        routes: [
          {
            handle: [
              {
                handler: "headers",
                request: {
                  set: {
                    Authorization: [
                      "{http.reverse_proxy.header.X-Inject-Authorization}",
                    ],
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function buildRoute(
  route: { domain: string; upstream: string },
  managerAddress: string,
  withAuth = true,
): CaddyRoute {
  const handlers: Record<string, unknown>[] = [];
  if (withAuth) {
    handlers.push(buildForwardAuthHandler(managerAddress));
  }
  handlers.push(buildUpstreamHandler(route.upstream));

  return wrapInHostRoute(route.domain, [
    buildCorsPreflightSubroute(),
    { handle: handlers },
  ]);
}

function buildOpenCodeRoute(
  route: { domain: string; upstream: string },
  managerAddress: string,
): CaddyRoute {
  const upstream = buildUpstreamHandler(route.upstream);

  return wrapInHostRoute(route.domain, [
    buildCorsPreflightSubroute(),
    {
      match: [{ header: { Authorization: ["*"] } }],
      handle: [upstream],
      terminal: true,
    },
    {
      handle: [
        buildOpenCodeForwardAuthHandler(managerAddress),
        upstream,
      ],
    },
  ]);
}

function buildWildcardRoute(baseDomain: string): CaddyRoute {
  return {
    "@id": "wildcard-fallback",
    match: [{ host: [`*.${baseDomain}`] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            handle: [
              {
                handler: "static_response",
                body: "Sandbox not found or not running",
                status_code: 502,
              },
            ],
          },
        ],
      },
    ],
    terminal: true,
  };
}

export class CaddyProxyProvider implements ProxyProvider {
  readonly name = "caddy";

  private readonly mutex = new Mutex();

  constructor(
    private readonly providerConfig: ProxyProviderConfig & { adminApi: string },
  ) {}

  private get routesUrl(): string {
    return `${this.providerConfig.adminApi}${ROUTES_PATH}`;
  }

  private async fetchRoutes(): Promise<CaddyRoute[]> {
    const res = await fetch(this.routesUrl);
    if (!res.ok) return [];
    const data: unknown = await res.json();
    return Array.isArray(data) ? (data as CaddyRoute[]) : [];
  }

  private async patchRoutes(routes: CaddyRoute[]): Promise<void> {
    const res = await fetch(this.routesUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(routes),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Caddy PATCH failed (${res.status}): ${body}`);
    }
  }

  private async mutateRoutes(
    fn: (routes: CaddyRoute[]) => CaddyRoute[],
  ): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const allRoutes = await this.fetchRoutes();
      const wildcard = allRoutes.find(isWildcardRoute);
      const routes = allRoutes.filter((route) => !isWildcardRoute(route));
      const updated = fn(routes);
      await this.patchRoutes([
        ...updated,
        wildcard ?? buildWildcardRoute(this.providerConfig.baseDomain),
      ]);
    });
  }

  async addRoutes(routes: RouteConfig[]): Promise<void> {
    if (routes.length === 0) return;

    const stale = new Set(routes.map((route) => route.domain));
    const built = routes.map((route) => {
      if (route.auth === "opencode") {
        return buildOpenCodeRoute(route, this.providerConfig.managerAddress);
      }
      if (route.auth === "none") {
        return buildRoute(route, this.providerConfig.managerAddress, false);
      }
      return buildRoute(route, this.providerConfig.managerAddress);
    });

    await this.mutateRoutes((existing) => [
      ...existing.filter((route) => {
        const id = routeId(route);
        return id == null || !stale.has(id);
      }),
      ...built,
    ]);

    log.info({ count: routes.length, domains: [...stale] }, "Routes added");
  }

  async removeRoute(domain: string): Promise<void> {
    await this.mutateRoutes((routes) =>
      routes.filter((route) => route["@id"] !== domain),
    );
  }

  async removeRoutesMatchingSuffix(suffix: string): Promise<number> {
    let removedCount = 0;

    await this.mutateRoutes((routes) => {
      const kept = routes.filter((route) => !route["@id"]?.endsWith(suffix));
      removedCount = routes.length - kept.length;
      return kept;
    });

    return removedCount;
  }

  async getRegisteredDomains(): Promise<string[]> {
    const routes = await this.fetchRoutes();
    return routes
      .map((route) => route["@id"])
      .filter((domain): domain is string => typeof domain === "string");
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.providerConfig.adminApi}/config/`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async getDebugConfig(): Promise<unknown> {
    const res = await fetch(`${this.providerConfig.adminApi}/config/`);
    if (!res.ok) {
      throw new Error(`Failed to get Caddy config: ${res.statusText}`);
    }
    return res.json();
  }
}
