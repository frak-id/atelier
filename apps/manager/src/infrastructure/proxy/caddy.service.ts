import { CADDY } from "@frak/atelier-shared/constants";
import { Mutex } from "async-mutex";
import { config, isMock } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("caddy");

// ── Types ────────────────────────────────────────────────────────────

interface RouteDefinition {
  domain: string;
  upstream: string;
}

/**
 * Caddy route shape from the admin API.
 *
 * We only inspect `@id` and `match` for filtering; additional
 * Caddy-internal fields pass through untouched at runtime.
 */
interface CaddyRoute {
  "@id"?: string;
  match?: Array<{ host?: string[] }>;
  handle?: unknown[];
  terminal?: boolean;
}

// ── Serialized mutation ──────────────────────────────────────────────

const ROUTES_PATH = `${CADDY.ADMIN_API}/config/apps/http/servers/srv0/routes`;

const mutex = new Mutex();

// ── Internal helpers ─────────────────────────────────────────────────

function routeId(r: CaddyRoute): string | undefined {
  return r["@id"];
}

function isWildcardRoute(route: CaddyRoute): boolean {
  return route.match?.[0]?.host?.some((h) => h.startsWith("*.")) ?? false;
}

async function fetchRoutes(): Promise<CaddyRoute[]> {
  const res = await fetch(ROUTES_PATH);
  if (!res.ok) return [];
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as CaddyRoute[]) : [];
}

async function patchRoutes(routes: CaddyRoute[]): Promise<void> {
  const res = await fetch(ROUTES_PATH, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(routes),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Caddy PATCH failed (${res.status}): ${body}`);
  }
}

/**
 * Atomic read-modify-write on the srv0 routes array.
 *
 * 1. GET current routes
 * 2. Separate wildcard fallback from regular routes
 * 3. Apply `fn` to regular routes only
 * 4. Re-append wildcard last (create one if missing)
 * 5. PATCH the entire array atomically
 *
 * The mutex ensures concurrent callers queue instead of interleaving.
 */
async function mutateRoutes(
  fn: (routes: CaddyRoute[]) => CaddyRoute[],
): Promise<void> {
  await mutex.runExclusive(async () => {
    const all = await fetchRoutes();
    const wildcard = all.find(isWildcardRoute);
    const routes = all.filter((r) => !isWildcardRoute(r));
    const updated = fn(routes);
    await patchRoutes([...updated, wildcard ?? buildWildcardRoute()]);
  });
}

// ── Route builders ───────────────────────────────────────────────────

function getManagerDialAddress(): string {
  const host =
    config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  return `${host}:${config.server.port}`;
}

function buildForwardAuthHandler(): Record<string, unknown> {
  return {
    handler: "reverse_proxy",
    upstreams: [{ dial: getManagerDialAddress() }],
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

/**
 * CORS headers shared between the OPTIONS preflight handler and the
 * reverse-proxy response. Uses Origin reflection instead of a wildcard
 * because wildcard is incompatible with credentials.
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ["{http.request.header.Origin}"],
  "Access-Control-Allow-Credentials": ["true"],
  Vary: ["Origin"],
} as const;

function buildRoute({ domain, upstream }: RouteDefinition): CaddyRoute {
  const handlers: Record<string, unknown>[] = [];

  if (!isMock()) {
    handlers.push(buildForwardAuthHandler());
  }

  handlers.push({
    handler: "reverse_proxy",
    upstreams: [{ dial: upstream }],
    transport: { protocol: "http", read_buffer_size: 4096 },
    headers: { response: { set: { ...CORS_HEADERS } } },
    flush_interval: -1,
  });

  return {
    "@id": domain,
    match: [{ host: [domain] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          {
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
          },
          { handle: handlers },
        ],
      },
    ],
    terminal: true,
  };
}

function buildWildcardRoute(): CaddyRoute {
  return {
    "@id": "wildcard-fallback",
    match: [{ host: [`*.${config.domain.baseDomain}`] }],
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

// ── Public API ───────────────────────────────────────────────────────

export const CaddyService = {
  async registerRoutes(
    sandboxId: string,
    ipAddress: string,
    ports: { vscode: number; opencode: number },
  ): Promise<{ vscode: string; opencode: string }> {
    const base = config.domain.baseDomain;
    const vscodeDomain = `sandbox-${sandboxId}.${base}`;
    const opencodeDomain = `opencode-${sandboxId}.${base}`;

    if (isMock()) {
      log.debug(
        { sandboxId, vscodeDomain, opencodeDomain },
        "Mock: Caddy routes registered",
      );
      return {
        vscode: `https://${vscodeDomain}`,
        opencode: `https://${opencodeDomain}`,
      };
    }

    const stale = new Set([vscodeDomain, opencodeDomain]);
    await mutateRoutes((routes) => [
      ...routes.filter((r) => {
        const id = routeId(r);
        return id == null || !stale.has(id);
      }),
      buildRoute({
        domain: vscodeDomain,
        upstream: `${ipAddress}:${ports.vscode}`,
      }),
      buildRoute({
        domain: opencodeDomain,
        upstream: `${ipAddress}:${ports.opencode}`,
      }),
    ]);

    log.info(
      { sandboxId, vscodeDomain, opencodeDomain },
      "Caddy routes registered",
    );
    return {
      vscode: `https://${vscodeDomain}`,
      opencode: `https://${opencodeDomain}`,
    };
  },

  async registerDevRoute(
    sandboxId: string,
    ipAddress: string,
    name: string,
    port: number,
    isDefault: boolean,
    extraPorts?: Array<{ port: number; alias: string }>,
  ): Promise<{
    namedUrl: string;
    defaultUrl?: string;
    extraDevUrls?: Array<{
      alias: string;
      port: number;
      url: string;
    }>;
  }> {
    const base = config.domain.baseDomain;
    const namedDomain = `dev-${name}-${sandboxId}.${base}`;

    const extraDevUrls = (extraPorts ?? []).map((ep) => ({
      alias: ep.alias,
      port: ep.port,
      url: `https://dev-${name}-${ep.alias}-${sandboxId}.${base}`,
    }));

    if (isMock()) {
      log.debug(
        {
          sandboxId,
          name,
          namedDomain,
          extraPorts: extraPorts?.length ?? 0,
        },
        "Mock: Dev route registered",
      );
      return {
        namedUrl: `https://${namedDomain}`,
        defaultUrl: isDefault ? `https://dev-${sandboxId}.${base}` : undefined,
        extraDevUrls: extraDevUrls.length > 0 ? extraDevUrls : undefined,
      };
    }

    const newRoutes: RouteDefinition[] = [
      { domain: namedDomain, upstream: `${ipAddress}:${port}` },
    ];
    const stale = new Set([namedDomain]);

    for (const ep of extraPorts ?? []) {
      const d = `dev-${name}-${ep.alias}-${sandboxId}.${base}`;
      stale.add(d);
      newRoutes.push({
        domain: d,
        upstream: `${ipAddress}:${ep.port}`,
      });
    }

    let defaultUrl: string | undefined;
    if (isDefault) {
      const d = `dev-${sandboxId}.${base}`;
      stale.add(d);
      newRoutes.push({
        domain: d,
        upstream: `${ipAddress}:${port}`,
      });
      defaultUrl = `https://${d}`;
    }

    await mutateRoutes((routes) => [
      ...routes.filter((r) => {
        const id = routeId(r);
        return id == null || !stale.has(id);
      }),
      ...newRoutes.map(buildRoute),
    ]);

    log.info(
      {
        sandboxId,
        name,
        namedDomain,
        extraPorts: extraPorts?.length ?? 0,
        defaultDomain: isDefault ? `dev-${sandboxId}.${base}` : undefined,
      },
      "Dev route registered",
    );

    return {
      namedUrl: `https://${namedDomain}`,
      defaultUrl,
      extraDevUrls: extraDevUrls.length > 0 ? extraDevUrls : undefined,
    };
  },

  async removeDevRoute(
    sandboxId: string,
    name: string,
    isDefault: boolean,
    extraPorts?: Array<{ alias: string }>,
  ): Promise<void> {
    if (isMock()) {
      log.debug({ sandboxId, name }, "Mock: Dev route removed");
      return;
    }

    const base = config.domain.baseDomain;
    const stale = new Set([`dev-${name}-${sandboxId}.${base}`]);

    for (const ep of extraPorts ?? []) {
      stale.add(`dev-${name}-${ep.alias}-${sandboxId}.${base}`);
    }

    if (isDefault) {
      stale.add(`dev-${sandboxId}.${base}`);
    }

    await mutateRoutes((routes) =>
      routes.filter((r) => {
        const id = routeId(r);
        return id == null || !stale.has(id);
      }),
    );

    log.info({ sandboxId, name }, "Dev route removed");
  },

  async registerBrowserRoute(
    sandboxId: string,
    ipAddress: string,
    port: number,
  ): Promise<string> {
    const base = config.domain.baseDomain;
    const browserDomain = `browser-${sandboxId}.${base}`;

    if (isMock()) {
      log.debug({ sandboxId, browserDomain }, "Mock: Browser route registered");
      return `https://${browserDomain}`;
    }

    await mutateRoutes((routes) => [
      ...routes.filter((r) => r["@id"] !== browserDomain),
      buildRoute({
        domain: browserDomain,
        upstream: `${ipAddress}:${port}`,
      }),
    ]);

    log.info({ sandboxId, browserDomain }, "Browser route registered");
    return `https://${browserDomain}`;
  },

  async removeBrowserRoute(sandboxId: string): Promise<void> {
    if (isMock()) {
      log.debug({ sandboxId }, "Mock: Browser route removed");
      return;
    }

    const domain = `browser-${sandboxId}.${config.domain.baseDomain}`;

    await mutateRoutes((routes) => routes.filter((r) => r["@id"] !== domain));

    log.info({ sandboxId }, "Browser route removed");
  },

  /**
   * Remove every Caddy route belonging to a sandbox.
   *
   * All sandbox route @ids end with `-{sandboxId}.{baseDomain}`
   * (sandbox-, opencode-, browser-, dev-*-), so a single suffix
   * match covers all of them in one atomic PATCH.
   */
  async removeRoutes(sandboxId: string): Promise<void> {
    if (isMock()) {
      log.debug({ sandboxId }, "Mock: Caddy routes removed");
      return;
    }

    const suffix = `-${sandboxId}.${config.domain.baseDomain}`;
    let removedCount = 0;

    await mutateRoutes((routes) => {
      const kept = routes.filter((r) => !r["@id"]?.endsWith(suffix));
      removedCount = routes.length - kept.length;
      return kept;
    });

    log.info(
      { sandboxId, routesRemoved: removedCount },
      "Caddy routes removed",
    );
  },

  async removeRoute(domain: string): Promise<void> {
    if (isMock()) return;

    await mutateRoutes((routes) => routes.filter((r) => r["@id"] !== domain));
  },

  async getRoutes(): Promise<CaddyRoute[]> {
    if (isMock()) return [];
    return fetchRoutes();
  },

  async getConfig(): Promise<unknown> {
    if (isMock()) {
      return {
        mock: true,
        message: "Caddy not available in mock mode",
      };
    }

    const res = await fetch(`${CADDY.ADMIN_API}/config/`);
    if (!res.ok) {
      throw new Error(`Failed to get Caddy config: ${res.statusText}`);
    }
    return res.json();
  },

  async isHealthy(): Promise<boolean> {
    if (isMock()) return true;

    try {
      const res = await fetch(`${CADDY.ADMIN_API}/config/`);
      return res.ok;
    } catch {
      return false;
    }
  },
};
