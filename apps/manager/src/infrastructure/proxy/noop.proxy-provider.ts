import { createChildLogger } from "../../shared/lib/logger.ts";
import type { ProxyProvider, RouteConfig } from "./proxy.provider.ts";

const log = createChildLogger("proxy:noop");

export class NoopProxyProvider implements ProxyProvider {
  readonly name = "none";

  async addRoutes(routes: RouteConfig[]): Promise<void> {
    log.debug({ routes }, "No-op addRoutes");
  }

  async removeRoute(domain: string): Promise<void> {
    log.debug({ domain }, "No-op removeRoute");
  }

  async removeRoutesMatchingSuffix(suffix: string): Promise<number> {
    log.debug({ suffix }, "No-op removeRoutesMatchingSuffix");
    return 0;
  }

  async getRegisteredDomains(): Promise<string[]> {
    log.debug("No-op getRegisteredDomains");
    return [];
  }

  async isHealthy(): Promise<boolean> {
    log.debug("No-op isHealthy");
    return true;
  }

  async getDebugConfig(): Promise<unknown> {
    log.debug("No-op getDebugConfig");
    return {
      provider: "none",
      message: "No proxy provider configured",
    };
  }
}
