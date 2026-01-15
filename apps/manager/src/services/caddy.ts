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
    ports: { vscode: number; opencode: number }
  ): Promise<{ vscode: string; opencode: string }> {
    const vscodeDomain = `sandbox-${sandboxId}.${config.caddy.domainSuffix}`;
    const opencodeDomain = `opencode-${sandboxId}.${config.caddy.domainSuffix}`;

    if (config.isMock()) {
      log.debug({ sandboxId, vscodeDomain, opencodeDomain }, "Mock: Caddy routes registered");
      return {
        vscode: `https://${vscodeDomain}`,
        opencode: `https://${opencodeDomain}`,
      };
    }

    await this.addRoute(vscodeDomain, `${ipAddress}:${ports.vscode}`);
    await this.addRoute(opencodeDomain, `${ipAddress}:${ports.opencode}`);

    log.info({ sandboxId, vscodeDomain, opencodeDomain }, "Caddy routes registered");

    return {
      vscode: `https://${vscodeDomain}`,
      opencode: `https://${opencodeDomain}`,
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
        },
      ],
      terminal: true,
    };

    const response = await fetch(`${config.caddy.adminApi}/config/apps/http/servers/srv0/routes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(routeConfig),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to add Caddy route: ${error}`);
    }
  },

  async removeRoutes(sandboxId: string): Promise<void> {
    const vscodeDomain = `sandbox-${sandboxId}.${config.caddy.domainSuffix}`;
    const opencodeDomain = `opencode-${sandboxId}.${config.caddy.domainSuffix}`;

    if (config.isMock()) {
      log.debug({ sandboxId }, "Mock: Caddy routes removed");
      return;
    }

    await this.removeRoute(vscodeDomain);
    await this.removeRoute(opencodeDomain);

    log.info({ sandboxId }, "Caddy routes removed");
  },

  async removeRoute(domain: string): Promise<void> {
    const response = await fetch(`${config.caddy.adminApi}/id/${domain}`, {
      method: "DELETE",
    });

    if (!response.ok && response.status !== 404) {
      log.warn({ domain, status: response.status }, "Failed to remove Caddy route");
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
      `${config.caddy.adminApi}/config/apps/http/servers/srv0/routes`
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
