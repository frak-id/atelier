import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("caddy");

interface RouteDefinition {
  domain: string;
  upstream: string;
}

function buildForwardAuthHandler(): object {
  return {
    handler: "reverse_proxy",
    upstreams: [{ dial: `${config.host}:${config.port}` }],
    rewrite: {
      method: "GET",
      uri: "/auth/verify",
    },
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
            handle: [
              {
                handler: "headers",
                request: { set: {} },
              },
            ],
          },
        ],
      },
    ],
  };
}

export const CaddyService = {
  async registerRoutes(
    sandboxId: string,
    ipAddress: string,
    ports: { vscode: number; opencode: number },
  ): Promise<{ vscode: string; opencode: string }> {
    const vscodeDomain = `sandbox-${sandboxId}.${config.caddy.domainSuffix}`;
    const opencodeDomain = `opencode-${sandboxId}.${config.caddy.domainSuffix}`;

    if (config.isMock()) {
      log.debug(
        { sandboxId, vscodeDomain, opencodeDomain },
        "Mock: Caddy routes registered",
      );
      return {
        vscode: `https://${vscodeDomain}`,
        opencode: `https://${opencodeDomain}`,
      };
    }

    await this.addRoutes([
      { domain: vscodeDomain, upstream: `${ipAddress}:${ports.vscode}` },
      { domain: opencodeDomain, upstream: `${ipAddress}:${ports.opencode}` },
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

  async addRoutes(routes: RouteDefinition[]): Promise<void> {
    const wildcardIndex = await this.findWildcardRouteIndex();
    const hadWildcard = wildcardIndex >= 0;

    if (hadWildcard) {
      await fetch(
        `${config.caddy.adminApi}/config/apps/http/servers/srv0/routes/${wildcardIndex}`,
        { method: "DELETE" },
      );
    }

    await Promise.all(routes.map((route) => this.addRouteDirect(route)));

    if (hadWildcard) {
      await this.addWildcardFallback();
    }
  },

  async addRouteDirect(route: RouteDefinition): Promise<void> {
    await this.removeRoute(route.domain);

    const corsResponseHeaders = {
      set: {
        "Access-Control-Allow-Origin": [config.dashboardUrl],
        "Access-Control-Allow-Credentials": ["true"],
      },
    };

    const handlers: object[] = [];

    if (!config.isMock()) {
      handlers.push(buildForwardAuthHandler());
    }

    handlers.push({
      handler: "reverse_proxy",
      upstreams: [{ dial: route.upstream }],
      transport: {
        protocol: "http",
        read_buffer_size: 4096,
      },
      headers: {
        response: corsResponseHeaders,
      },
      flush_interval: -1,
    });

    const routeConfig = {
      "@id": route.domain,
      match: [{ host: [route.domain] }],
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
                      ...corsResponseHeaders.set,
                      "Access-Control-Allow-Methods": [
                        "GET, POST, PUT, DELETE, PATCH, OPTIONS",
                      ],
                      "Access-Control-Allow-Headers": [
                        "Content-Type, Authorization, X-Requested-With",
                      ],
                    },
                  },
                },
              ],
              match: [{ method: ["OPTIONS"] }],
              terminal: true,
            },
            {
              handle: handlers,
            },
          ],
        },
      ],
      terminal: true,
    };

    const response = await fetch(
      `${config.caddy.adminApi}/config/apps/http/servers/srv0/routes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(routeConfig),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to add Caddy route: ${error}`);
    }
  },

  async addRoute(domain: string, upstream: string): Promise<void> {
    await this.addRoutes([{ domain, upstream }]);
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
    extraDevUrls?: Array<{ alias: string; port: number; url: string }>;
  }> {
    const namedDomain = `dev-${name}-${sandboxId}.${config.caddy.domainSuffix}`;

    const extraDevUrls = (extraPorts ?? []).map((ep) => ({
      alias: ep.alias,
      port: ep.port,
      url: `https://dev-${name}-${ep.alias}-${sandboxId}.${config.caddy.domainSuffix}`,
    }));

    if (config.isMock()) {
      const defaultUrl = isDefault
        ? `https://dev-${sandboxId}.${config.caddy.domainSuffix}`
        : undefined;
      log.debug(
        { sandboxId, name, namedDomain, extraPorts: extraPorts?.length ?? 0 },
        "Mock: Dev route registered",
      );
      return {
        namedUrl: `https://${namedDomain}`,
        defaultUrl,
        extraDevUrls: extraDevUrls.length > 0 ? extraDevUrls : undefined,
      };
    }

    await this.addRoute(namedDomain, `${ipAddress}:${port}`);

    for (const ep of extraPorts ?? []) {
      const epDomain = `dev-${name}-${ep.alias}-${sandboxId}.${config.caddy.domainSuffix}`;
      await this.addRoute(epDomain, `${ipAddress}:${ep.port}`);
    }

    let defaultUrl: string | undefined;
    if (isDefault) {
      const defaultDomain = `dev-${sandboxId}.${config.caddy.domainSuffix}`;
      await this.addRoute(defaultDomain, `${ipAddress}:${port}`);
      defaultUrl = `https://${defaultDomain}`;
    }

    log.info(
      {
        sandboxId,
        name,
        namedDomain,
        extraPorts: extraPorts?.length ?? 0,
        defaultDomain: isDefault
          ? `dev-${sandboxId}.${config.caddy.domainSuffix}`
          : undefined,
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
    if (config.isMock()) {
      log.debug({ sandboxId, name }, "Mock: Dev route removed");
      return;
    }

    await this.removeRoute(
      `dev-${name}-${sandboxId}.${config.caddy.domainSuffix}`,
    );

    for (const ep of extraPorts ?? []) {
      await this.removeRoute(
        `dev-${name}-${ep.alias}-${sandboxId}.${config.caddy.domainSuffix}`,
      );
    }

    if (isDefault) {
      await this.removeRoute(`dev-${sandboxId}.${config.caddy.domainSuffix}`);
    }

    log.info({ sandboxId, name }, "Dev route removed");
  },

  async findWildcardRouteIndex(): Promise<number> {
    try {
      const routes = await this.getRoutes();
      for (let i = 0; i < routes.length; i++) {
        const route = routes[i] as {
          match?: Array<{ host?: string[] }>;
        };
        const hosts = route?.match?.[0]?.host;
        if (hosts?.some((h) => h.startsWith("*."))) {
          return i;
        }
      }
    } catch {
      log.warn("Failed to find wildcard route index");
    }
    return -1;
  },

  async addWildcardFallback(): Promise<void> {
    const wildcardConfig = {
      "@id": "wildcard-fallback",
      match: [{ host: [`*.${config.caddy.domainSuffix}`] }],
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

    await fetch(
      `${config.caddy.adminApi}/config/apps/http/servers/srv0/routes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(wildcardConfig),
      },
    );
  },

  async registerBrowserRoute(
    sandboxId: string,
    ipAddress: string,
    port: number,
  ): Promise<string> {
    const browserDomain = `browser-${sandboxId}.${config.caddy.domainSuffix}`;

    if (config.isMock()) {
      log.debug({ sandboxId, browserDomain }, "Mock: Browser route registered");
      return `https://${browserDomain}`;
    }

    await this.addRoutes([
      { domain: browserDomain, upstream: `${ipAddress}:${port}` },
    ]);
    log.info({ sandboxId, browserDomain }, "Browser route registered");
    return `https://${browserDomain}`;
  },

  async removeBrowserRoute(sandboxId: string): Promise<void> {
    const browserDomain = `browser-${sandboxId}.${config.caddy.domainSuffix}`;

    if (config.isMock()) {
      log.debug({ sandboxId }, "Mock: Browser route removed");
      return;
    }

    await this.removeRoute(browserDomain);
    log.info({ sandboxId }, "Browser route removed");
  },

  async removeRoutes(sandboxId: string): Promise<void> {
    const vscodeDomain = `sandbox-${sandboxId}.${config.caddy.domainSuffix}`;
    const opencodeDomain = `opencode-${sandboxId}.${config.caddy.domainSuffix}`;

    if (config.isMock()) {
      log.debug({ sandboxId }, "Mock: Caddy routes removed");
      return;
    }

    const devRouteDomains = await this.findDevRoutesForSandbox(sandboxId);

    const browserDomain = `browser-${sandboxId}.${config.caddy.domainSuffix}`;

    await Promise.all([
      this.removeRoute(vscodeDomain),
      this.removeRoute(opencodeDomain),
      this.removeRoute(browserDomain),
      ...devRouteDomains.map((domain) => this.removeRoute(domain)),
    ]);

    log.info(
      { sandboxId, devRoutesRemoved: devRouteDomains.length },
      "Caddy routes removed",
    );
  },

  async findDevRoutesForSandbox(sandboxId: string): Promise<string[]> {
    try {
      const routes = await this.getRoutes();
      const suffix = `${sandboxId}.${config.caddy.domainSuffix}`;
      const domains: string[] = [];

      for (const route of routes) {
        const r = route as { "@id"?: string };
        const id = r["@id"];
        if (id?.startsWith("dev-") && id.endsWith(suffix)) {
          domains.push(id);
        }
      }

      return domains;
    } catch {
      log.warn({ sandboxId }, "Failed to find dev routes for cleanup");
      return [];
    }
  },

  async removeRoute(domain: string): Promise<void> {
    const response = await fetch(`${config.caddy.adminApi}/id/${domain}`, {
      method: "DELETE",
    });

    if (!response.ok && response.status !== 404) {
      log.warn(
        { domain, status: response.status },
        "Failed to remove Caddy route",
      );
    }
  },

  async getConfig(): Promise<unknown> {
    if (config.isMock()) {
      return { mock: true, message: "Caddy not available in mock mode" };
    }

    const response = await fetch(`${config.caddy.adminApi}/config/`);
    if (!response.ok) {
      throw new Error(`Failed to get Caddy config: ${response.statusText}`);
    }
    return response.json();
  },

  async getRoutes(): Promise<unknown[]> {
    if (config.isMock()) {
      return [];
    }

    const response = await fetch(
      `${config.caddy.adminApi}/config/apps/http/servers/srv0/routes`,
    );
    if (!response.ok) {
      return [];
    }
    const routes = await response.json();
    return Array.isArray(routes) ? routes : [];
  },

  async isHealthy(): Promise<boolean> {
    if (config.isMock()) {
      return true;
    }

    try {
      const response = await fetch(`${config.caddy.adminApi}/config/`);
      return response.ok;
    } catch {
      return false;
    }
  },
};
