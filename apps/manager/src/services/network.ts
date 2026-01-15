import { exec } from "../lib/shell.ts";
import { config } from "../lib/config.ts";
import { createChildLogger } from "../lib/logger.ts";

const log = createChildLogger("network");

let nextIpOctet = config.network.GUEST_IP_START;
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
    while (allocatedIps.has(nextIpOctet) && nextIpOctet < 255) {
      nextIpOctet++;
    }

    if (nextIpOctet >= 255) {
      throw new Error("No available IP addresses in subnet");
    }

    const ipOctet = nextIpOctet;
    allocatedIps.add(ipOctet);
    nextIpOctet++;

    const allocation: NetworkAllocation = {
      ipAddress: `${config.network.GUEST_SUBNET}.${ipOctet}`,
      macAddress: generateMac(ipOctet),
      tapDevice: `tap-${sandboxId.slice(0, 8)}`,
      gateway: config.network.BRIDGE_IP,
    };

    log.debug({ sandboxId, allocation }, "Network allocated");
    return allocation;
  },

  async createTap(tapDevice: string): Promise<void> {
    if (config.isMock()) {
      log.debug({ tapDevice }, "Mock: TAP device creation skipped");
      return;
    }

    await exec(`ip link del ${tapDevice} 2>/dev/null || true`);
    await exec(`ip tuntap add dev ${tapDevice} mode tap`);
    await exec(`ip link set dev ${tapDevice} master ${config.network.BRIDGE_NAME}`);
    await exec(`ip link set dev ${tapDevice} up`);

    log.info({ tapDevice }, "TAP device created");
  },

  async deleteTap(tapDevice: string): Promise<void> {
    if (config.isMock()) {
      log.debug({ tapDevice }, "Mock: TAP device deletion skipped");
      return;
    }

    await exec(`ip link del ${tapDevice} 2>/dev/null || true`);
    log.info({ tapDevice }, "TAP device deleted");
  },

  release(ipAddress: string): void {
    const parts = ipAddress.split(".");
    const octet = Number.parseInt(parts[3] ?? "0", 10);
    allocatedIps.delete(octet);
    log.debug({ ipAddress }, "IP address released");
  },

  async getBridgeStatus(): Promise<{
    exists: boolean;
    ip: string | null;
    interfaces: string[];
  }> {
    if (config.isMock()) {
      return { exists: true, ip: config.network.BRIDGE_IP, interfaces: [] };
    }

    const bridgeCheck = await exec(
      `ip link show ${config.network.BRIDGE_NAME}`,
      { throws: false }
    );

    if (!bridgeCheck.success) {
      return { exists: false, ip: null, interfaces: [] };
    }

    const ipResult = await exec(
      `ip -j addr show ${config.network.BRIDGE_NAME} | jq -r '.[0].addr_info[0].local // empty'`,
      { throws: false }
    );

    const interfacesResult = await exec(
      `bridge link show master ${config.network.BRIDGE_NAME} 2>/dev/null | awk '{print $2}' | tr -d ':'`,
      { throws: false }
    );

    return {
      exists: true,
      ip: ipResult.stdout || null,
      interfaces: interfacesResult.stdout.split("\n").filter(Boolean),
    };
  },

  async listTapDevices(): Promise<string[]> {
    if (config.isMock()) {
      return [];
    }

    const result = await exec(
      `ip link show type tuntap | grep -E '^[0-9]+: tap-' | awk -F': ' '{print $2}'`,
      { throws: false }
    );

    return result.stdout.split("\n").filter(Boolean);
  },
};
