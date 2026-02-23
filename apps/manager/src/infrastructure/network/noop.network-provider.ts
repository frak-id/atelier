import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { BridgeStatus, NetworkProvider } from "./network.provider.ts";

const log = createChildLogger("network:noop");

export class NoopNetworkProvider implements NetworkProvider {
  readonly name = "none";

  async createTap(tapDevice: string): Promise<void> {
    log.debug({ tapDevice }, "No-op createTap");
  }

  async deleteTap(tapDevice: string): Promise<void> {
    log.debug({ tapDevice }, "No-op deleteTap");
  }

  async listTapDevices(): Promise<string[]> {
    log.debug("No-op listTapDevices");
    return [];
  }

  async getBridgeStatus(): Promise<BridgeStatus> {
    log.debug("No-op getBridgeStatus");
    return { exists: true, ip: config.network.bridgeIp, interfaces: [] };
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }
}
