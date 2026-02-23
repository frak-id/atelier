import { $ } from "bun";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { BridgeStatus, NetworkProvider } from "./network.provider.ts";

const log = createChildLogger("network:bridge");

export class BridgeNetworkProvider implements NetworkProvider {
  readonly name = "bridge";

  async createTap(tapDevice: string): Promise<void> {
    await $`sudo -n /sbin/ip link del ${tapDevice} 2>/dev/null || true`
      .quiet()
      .nothrow();
    await $`sudo -n /sbin/ip tuntap add dev ${tapDevice} mode tap`.quiet();
    await $`sudo -n /sbin/ip link set dev ${tapDevice} master ${config.network.bridgeName} up`.quiet();
    log.info({ tapDevice }, "TAP device created");
  }

  async deleteTap(tapDevice: string): Promise<void> {
    await $`sudo -n /sbin/ip link del ${tapDevice} 2>/dev/null || true`
      .quiet()
      .nothrow();
    log.info({ tapDevice }, "TAP device deleted");
  }

  async listTapDevices(): Promise<string[]> {
    const result = await $`sudo -n /sbin/ip link show type tuntap`
      .quiet()
      .nothrow();
    if (result.exitCode !== 0) return [];

    return result.stdout
      .toString()
      .split("\n")
      .map((line) => line.match(/^\d+:\s+(tap-\S+):/)?.[1])
      .filter((device): device is string => !!device);
  }

  async getBridgeStatus(): Promise<BridgeStatus> {
    const bridgeName = config.network.bridgeName;
    const bridgeCheck = await $`sudo -n /sbin/ip link show ${bridgeName}`
      .quiet()
      .nothrow();

    if (bridgeCheck.exitCode !== 0) {
      return { exists: false, ip: null, interfaces: [] };
    }

    const ipResult = await $`sudo -n /sbin/ip -j addr show ${bridgeName}`
      .quiet()
      .nothrow();
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
      await $`sudo -n /sbin/bridge link show master ${bridgeName} 2>/dev/null`
        .quiet()
        .nothrow();
    const interfaces = interfacesResult.stdout
      .toString()
      .split("\n")
      .map((line) => line.match(/^\d+:\s+(\S+):/)?.[1])
      .filter((iface): iface is string => !!iface);

    return { exists: true, ip, interfaces };
  }

  async isHealthy(): Promise<boolean> {
    const status = await this.getBridgeStatus();
    return status.exists;
  }
}
