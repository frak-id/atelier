import type { AtelierConfig } from "@frak/atelier-shared";

export interface RouteConfig {
  /** Full domain (e.g., "sandbox-abc.example.com") */
  domain: string;
  /** Upstream address (e.g., "172.16.0.10:8080") */
  upstream: string;
  /** Authentication mode for this route */
  auth: "standard" | "opencode" | "none";
  /** Health check path on the upstream (e.g., "/healthz"). Omit to skip. */
  healthPath?: string;
}

export interface ProxyProvider {
  /** Provider name for logging and diagnostics */
  readonly name: string;

  /**
   * Register one or more routes atomically.
   * If routes with the same domains already exist, they are replaced.
   */
  addRoutes(routes: RouteConfig[]): Promise<void>;

  /**
   * Remove a single route by domain.
   */
  removeRoute(domain: string): Promise<void>;

  /**
   * Remove all routes whose domain ends with the given suffix.
   * Returns the number of routes removed.
   */
  removeRoutesMatchingSuffix(suffix: string): Promise<number>;

  /**
   * Return all currently registered route domains.
   */
  getRegisteredDomains(): Promise<string[]>;

  /**
   * Check if the proxy is healthy and accepting configuration.
   */
  isHealthy(): Promise<boolean>;

  /**
   * Return provider-specific debug configuration.
   */
  getDebugConfig(): Promise<unknown>;
}

export interface ProxyProviderConfig {
  baseDomain: AtelierConfig["domain"]["baseDomain"];
  managerAddress: string;
}
