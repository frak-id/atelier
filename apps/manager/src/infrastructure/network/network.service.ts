import { config, isMock } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { BridgeNetworkProvider } from "./bridge.network-provider.ts";
import type { NetworkProvider } from "./network.provider.ts";
import { NoopNetworkProvider } from "./noop.network-provider.ts";

const log = createChildLogger("network");

export interface NetworkAllocation {
  ipAddress: string;
  macAddress: string;
  tapDevice: string;
  gateway: string;
}

function generateMac(ipOctet: number): string {
  const hex = ipOctet.toString(16).padStart(2, "0");
  return `06:00:AC:10:00:${hex}`;
}

function createNetworkProvider(): NetworkProvider {
  if (isMock() || config.providers.network.type === "none") {
    return new NoopNetworkProvider();
  }
  return new BridgeNetworkProvider();
}

export class NetworkService {
  private readonly allocatedIps = new Set<number>();

  constructor(private readonly provider: NetworkProvider) {}

  async allocate(sandboxId: string): Promise<NetworkAllocation> {
    let ipOctet = config.network.guestIpStart;
    while (this.allocatedIps.has(ipOctet) && ipOctet < 255) {
      ipOctet++;
    }

    if (ipOctet >= 255) {
      throw new Error("No available IP addresses in subnet");
    }

    this.allocatedIps.add(ipOctet);

    const allocation: NetworkAllocation = {
      ipAddress: `${config.network.guestSubnet}.${ipOctet}`,
      macAddress: generateMac(ipOctet),
      tapDevice: `tap-${sandboxId.slice(0, 8)}`,
      gateway: config.network.bridgeIp,
    };

    log.debug({ sandboxId, allocation }, "Network allocated");
    return allocation;
  }

  async createTap(tapDevice: string): Promise<void> {
    return this.provider.createTap(tapDevice);
  }

  async deleteTap(tapDevice: string): Promise<void> {
    return this.provider.deleteTap(tapDevice);
  }

  release(ipAddress: string): void {
    const parts = ipAddress.split(".");
    const octet = Number.parseInt(parts[3] ?? "0", 10);
    this.allocatedIps.delete(octet);
    log.debug({ ipAddress }, "IP address released");
  }

  markAllocated(ipAddress: string): void {
    const parts = ipAddress.split(".");
    const octet = Number.parseInt(parts[3] ?? "0", 10);
    if (octet > 0 && octet < 255) {
      this.allocatedIps.add(octet);
      log.debug({ ipAddress, octet }, "IP address marked as allocated");
    }
  }

  getAllocatedCount(): number {
    return this.allocatedIps.size;
  }

  async getBridgeStatus(): Promise<{
    exists: boolean;
    ip: string | null;
    interfaces: string[];
  }> {
    return this.provider.getBridgeStatus();
  }

  async listTapDevices(): Promise<string[]> {
    return this.provider.listTapDevices();
  }
}

export const networkService = new NetworkService(createNetworkProvider());
