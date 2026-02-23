import { CADDY } from "@frak/atelier-shared/constants";
import { config, isMock } from "../../shared/lib/config.ts";
import { CaddyProxyProvider } from "./caddy.proxy-provider.ts";
import { NoopProxyProvider } from "./noop.proxy-provider.ts";
import type { ProxyProvider, RouteConfig } from "./proxy.provider.ts";

export class ProxyService {
  constructor(
    private readonly provider: ProxyProvider,
    private readonly baseDomain: string,
  ) {}

  async registerRoutes(
    sandboxId: string,
    ipAddress: string,
    ports: { vscode: number; opencode: number },
  ): Promise<{ vscode: string; opencode: string }> {
    const vscodeDomain = `sandbox-${sandboxId}.${this.baseDomain}`;
    const opencodeDomain = `opencode-${sandboxId}.${this.baseDomain}`;

    await this.provider.addRoutes([
      {
        domain: vscodeDomain,
        upstream: `${ipAddress}:${ports.vscode}`,
        auth: "standard",
        healthPath: "/healthz",
      },
      {
        domain: opencodeDomain,
        upstream: `${ipAddress}:${ports.opencode}`,
        auth: "opencode",
      },
    ]);

    return {
      vscode: `https://${vscodeDomain}`,
      opencode: `https://${opencodeDomain}`,
    };
  }

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
    const namedDomain = `dev-${name}-${sandboxId}.${this.baseDomain}`;
    const routes: RouteConfig[] = [
      {
        domain: namedDomain,
        upstream: `${ipAddress}:${port}`,
        auth: "none",
      },
    ];

    const extraDevUrls = (extraPorts ?? []).map((ep) => ({
      alias: ep.alias,
      port: ep.port,
      url: `https://dev-${name}-${ep.alias}-${sandboxId}.${this.baseDomain}`,
    }));

    for (const ep of extraPorts ?? []) {
      routes.push({
        domain: `dev-${name}-${ep.alias}-${sandboxId}.${this.baseDomain}`,
        upstream: `${ipAddress}:${ep.port}`,
        auth: "none",
      });
    }

    let defaultUrl: string | undefined;
    if (isDefault) {
      const defaultDomain = `dev-${sandboxId}.${this.baseDomain}`;
      routes.push({
        domain: defaultDomain,
        upstream: `${ipAddress}:${port}`,
        auth: "none",
      });
      defaultUrl = `https://${defaultDomain}`;
    }

    await this.provider.addRoutes(routes);

    return {
      namedUrl: `https://${namedDomain}`,
      defaultUrl,
      extraDevUrls: extraDevUrls.length > 0 ? extraDevUrls : undefined,
    };
  }

  async removeDevRoute(
    sandboxId: string,
    name: string,
    isDefault: boolean,
    extraPorts?: Array<{ alias: string }>,
  ): Promise<void> {
    await this.provider.removeRoute(
      `dev-${name}-${sandboxId}.${this.baseDomain}`,
    );
    for (const ep of extraPorts ?? []) {
      await this.provider.removeRoute(
        `dev-${name}-${ep.alias}-${sandboxId}.${this.baseDomain}`,
      );
    }
    if (isDefault) {
      await this.provider.removeRoute(`dev-${sandboxId}.${this.baseDomain}`);
    }
  }

  async registerBrowserRoute(
    sandboxId: string,
    ipAddress: string,
    port: number,
  ): Promise<string> {
    const browserDomain = `browser-${sandboxId}.${this.baseDomain}`;
    await this.provider.addRoutes([
      {
        domain: browserDomain,
        upstream: `${ipAddress}:${port}`,
        auth: "none",
      },
    ]);
    return `https://${browserDomain}`;
  }

  async removeBrowserRoute(sandboxId: string): Promise<void> {
    await this.provider.removeRoute(`browser-${sandboxId}.${this.baseDomain}`);
  }

  async removeRoutes(sandboxId: string): Promise<void> {
    const suffix = `-${sandboxId}.${this.baseDomain}`;
    await this.provider.removeRoutesMatchingSuffix(suffix);
  }

  async removeRoute(domain: string): Promise<void> {
    await this.provider.removeRoute(domain);
  }

  async getRegisteredDomains(): Promise<string[]> {
    return this.provider.getRegisteredDomains();
  }

  async getConfig(): Promise<unknown> {
    return this.provider.getDebugConfig();
  }

  async isHealthy(): Promise<boolean> {
    return this.provider.isHealthy();
  }
}

function getManagerDialAddress(): string {
  const host =
    config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  return `${host}:${config.server.port}`;
}

function createProxyProvider(): ProxyProvider {
  if (isMock() || config.providers.proxy.type === "none") {
    return new NoopProxyProvider();
  }

  return new CaddyProxyProvider({
    adminApi: CADDY.ADMIN_API,
    managerAddress: getManagerDialAddress(),
    baseDomain: config.domain.baseDomain,
  });
}

export const proxyService = new ProxyService(
  createProxyProvider(),
  config.domain.baseDomain,
);
