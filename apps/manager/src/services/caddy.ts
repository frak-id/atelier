import { config } from "../lib/config.ts";
import { createChildLogger } from "../lib/logger.ts";

const log = createChildLogger("caddy");

export interface CaddyRoute {
  sandboxId: string;
  subdomain: string;
  upstream: string;
}

export const CaddyService = {
  async registerRoutes(
    sandboxId: string,
    ipAddress: string,
    ports: { vscode: number; opencode: number; terminal: number },
  ): Promise<{ vscode: string; opencode: string; terminal: string }> {
    const vscodeDomain = `sandbox-${sandboxId}.${config.caddy.domainSuffix}`;
    const opencodeDomain = `opencode-${sandboxId}.${config.caddy.domainSuffix}`;
    const terminalDomain = `terminal-${sandboxId}.${config.caddy.domainSuffix}`;

    if (config.isMock()) {
      log.debug(
        { sandboxId, vscodeDomain, opencodeDomain, terminalDomain },
        "Mock: Caddy routes registered",
      );
      return {
        vscode: `https://${vscodeDomain}`,
        opencode: `https://${opencodeDomain}`,
        terminal: `https://${terminalDomain}`,
      };
    }

    await this.addRoute(vscodeDomain, `${ipAddress}:${ports.vscode}`);
    await this.addRoute(opencodeDomain, `${ipAddress}:${ports.opencode}`);
    await this.addRoute(terminalDomain, `${ipAddress}:${ports.terminal}`);

    log.info(
      { sandboxId, vscodeDomain, opencodeDomain, terminalDomain },
      "Caddy routes registered",
    );

    return {
      vscode: `https://${vscodeDomain}`,
      opencode: `https://${opencodeDomain}`,
      terminal: `https://${terminalDomain}`,
    };
  },

  async addRoute(domain: string, upstream: string): Promise<void> {
    const routeConfig = {
      "@id": domain,
      match: [{ host: [domain] }],
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: upstream }],
          // Enable WebSocket support for OpenCode SSE and code-server
          transport: {
            protocol: "http",
            read_buffer_size: 4096,
          },
          // Disable buffering for SSE streams
          flush_interval: -1,
        },
      ],
      terminal: true,
    };

    await this.ensureWildcardIsLast(async () => {
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
    });
  },

  async ensureWildcardIsLast(operation: () => Promise<void>): Promise<void> {
    const wildcardIndex = await this.findWildcardRouteIndex();
    const hadWildcard = wildcardIndex >= 0;

    if (hadWildcard) {
      await fetch(
        `${config.caddy.adminApi}/config/apps/http/servers/srv0/routes/${wildcardIndex}`,
        { method: "DELETE" },
      );
    }

    await operation();

    if (hadWildcard) {
      await this.addWildcardFallback();
    }
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

  async removeRoutes(sandboxId: string): Promise<void> {
    const vscodeDomain = `sandbox-${sandboxId}.${config.caddy.domainSuffix}`;
    const opencodeDomain = `opencode-${sandboxId}.${config.caddy.domainSuffix}`;
    const terminalDomain = `terminal-${sandboxId}.${config.caddy.domainSuffix}`;

    if (config.isMock()) {
      log.debug({ sandboxId }, "Mock: Caddy routes removed");
      return;
    }

    await this.removeRoute(vscodeDomain);
    await this.removeRoute(opencodeDomain);
    await this.removeRoute(terminalDomain);

    log.info({ sandboxId }, "Caddy routes removed");
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
