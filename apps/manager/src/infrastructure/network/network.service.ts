import { $ } from "bun";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("network");

const allocatedIps = new Set<number>();

function generateMac(ipOctet: number): string {
  const hex = ipOctet.toString(16).padStart(2, "0");
  return `06:00:AC:10:00:${hex}`;
}

export interface NetworkAllocation {
  ipAddress: string;
  macAddress: string;
  tapDevice: string;
  gateway: string;
}

export const NetworkService = {
  async allocate(sandboxId: string): Promise<NetworkAllocation> {
    let ipOctet = config.network.guestIpStart;
    while (allocatedIps.has(ipOctet) && ipOctet < 255) {
      ipOctet++;
    }

    if (ipOctet >= 255) {
      throw new Error("No available IP addresses in subnet");
    }

    allocatedIps.add(ipOctet);

    const allocation: NetworkAllocation = {
      ipAddress: `${config.network.guestSubnet}.${ipOctet}`,
      macAddress: generateMac(ipOctet),
      tapDevice: `tap-${sandboxId.slice(0, 8)}`,
      gateway: config.network.bridgeIp,
    };

    log.debug({ sandboxId, allocation }, "Network allocated");
    return allocation;
  },

  async createTap(tapDevice: string): Promise<void> {
    if (config.isMock()) {
      log.debug({ tapDevice }, "Mock: TAP device creation skipped");
      return;
    }

    await $`ip link del ${tapDevice} 2>/dev/null || true && ip tuntap add dev ${tapDevice} mode tap && ip link set dev ${tapDevice} master ${config.network.bridgeName} up`
      .quiet()
      .nothrow();

    log.info({ tapDevice }, "TAP device created");
  },

  async deleteTap(tapDevice: string): Promise<void> {
    if (config.isMock()) {
      log.debug({ tapDevice }, "Mock: TAP device deletion skipped");
      return;
    }

    await $`ip link del ${tapDevice} 2>/dev/null || true`.quiet().nothrow();
    log.info({ tapDevice }, "TAP device deleted");
  },

  release(ipAddress: string): void {
    const parts = ipAddress.split(".");
    const octet = Number.parseInt(parts[3] ?? "0", 10);
    allocatedIps.delete(octet);
    log.debug({ ipAddress }, "IP address released");
  },

  markAllocated(ipAddress: string): void {
    const parts = ipAddress.split(".");
    const octet = Number.parseInt(parts[3] ?? "0", 10);
    if (octet > 0 && octet < 255) {
      allocatedIps.add(octet);
      log.debug({ ipAddress, octet }, "IP address marked as allocated");
    }
  },

  getAllocatedCount(): number {
    return allocatedIps.size;
  },

  async getBridgeStatus(): Promise<{
    exists: boolean;
    ip: string | null;
    interfaces: string[];
  }> {
    if (config.isMock()) {
      return { exists: true, ip: config.network.bridgeIp, interfaces: [] };
    }

    const bridgeName = config.network.bridgeName;
    const bridgeCheck = await $`ip link show ${bridgeName}`.quiet().nothrow();

    if (bridgeCheck.exitCode !== 0) {
      return { exists: false, ip: null, interfaces: [] };
    }

    const ipResult = await $`ip -j addr show ${bridgeName}`.quiet().nothrow();
    let ip: string | null = null;
    if (ipResult.exitCode === 0) {
      try {
        const parsed = JSON.parse(ipResult.stdout.toString());
        ip = parsed[0]?.addr_info?.[0]?.local ?? null;
      } catch {
        ip = null;
      }
    }

    const interfacesResult =
      await $`bridge link show master ${bridgeName} 2>/dev/null`
        .quiet()
        .nothrow();
    const interfaces = interfacesResult.stdout
      .toString()
      .split("\n")
      .map((line) => line.match(/^\d+:\s+(\S+):/)?.[1])
      .filter((iface): iface is string => !!iface);

    return { exists: true, ip, interfaces };
  },

  async listTapDevices(): Promise<string[]> {
    if (config.isMock()) {
      return [];
    }

    const result = await $`ip link show type tuntap`.quiet().nothrow();
    if (result.exitCode !== 0) return [];

    return result.stdout
      .toString()
      .split("\n")
      .map((line) => line.match(/^\d+:\s+(tap-\S+):/)?.[1])
      .filter((device): device is string => !!device);
  },
};
