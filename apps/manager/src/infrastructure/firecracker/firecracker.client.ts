import { FIRECRACKER } from "@frak-sandbox/shared/constants";
import { $ } from "bun";
import { config } from "../../shared/lib/config.ts";
import { fileExists } from "../../shared/lib/shell.ts";

type RequestOptions = {
  method?: "GET" | "PUT" | "PATCH";
  body?: unknown;
};

export class FirecrackerClient {
  constructor(private socketPath: string) {}

  static async isHealthy(): Promise<boolean> {
    if (config.isMock()) {
      return true;
    }

    const exists = await fileExists(FIRECRACKER.BINARY_PATH);
    if (!exists) return false;

    const kvmOk = await $`test -r /dev/kvm && test -w /dev/kvm`
      .quiet()
      .nothrow();
    return kvmOk.exitCode === 0;
  }

  private async request<T = unknown>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const { method = "GET", body } = options;

    const response = await fetch(`http://localhost${path}`, {
      method,
      unix: this.socketPath,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    } as RequestInit);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Firecracker API error [${response.status}]: ${errorText}`,
      );
    }

    const text = await response.text();
    if (!text) return undefined as T;

    return JSON.parse(text) as T;
  }

  async getState(): Promise<{ state: string }> {
    return this.request("/");
  }

  async setBootSource(kernelPath: string, bootArgs: string): Promise<void> {
    await this.request("/boot-source", {
      method: "PUT",
      body: { kernel_image_path: kernelPath, boot_args: bootArgs },
    });
  }

  async setDrive(
    driveId: string,
    hostPath: string,
    isRoot: boolean,
    isReadOnly = false,
  ): Promise<void> {
    await this.request(`/drives/${driveId}`, {
      method: "PUT",
      body: {
        drive_id: driveId,
        path_on_host: hostPath,
        is_root_device: isRoot,
        is_read_only: isReadOnly,
      },
    });
  }

  async setNetworkInterface(
    ifaceId: string,
    guestMac: string,
    hostDevName: string,
  ): Promise<void> {
    await this.request(`/network-interfaces/${ifaceId}`, {
      method: "PUT",
      body: {
        iface_id: ifaceId,
        guest_mac: guestMac,
        host_dev_name: hostDevName,
      },
    });
  }

  async setCpuConfig(configPath: string): Promise<boolean> {
    try {
      const configFile = Bun.file(configPath);
      if (!(await configFile.exists())) return false;

      const config = await configFile.json();
      await this.request("/cpu-config", { method: "PUT", body: config });
      return true;
    } catch {
      return false;
    }
  }

  async setMachineConfig(vcpuCount: number, memSizeMib: number): Promise<void> {
    await this.request("/machine-config", {
      method: "PUT",
      body: { vcpu_count: vcpuCount, mem_size_mib: memSizeMib },
    });
  }

  async start(): Promise<void> {
    await this.request("/actions", {
      method: "PUT",
      body: { action_type: "InstanceStart" },
    });
  }

  async pause(): Promise<void> {
    await this.request("/vm", {
      method: "PATCH",
      body: { state: "Paused" },
    });
  }

  async resume(): Promise<void> {
    await this.request("/vm", {
      method: "PATCH",
      body: { state: "Resumed" },
    });
  }

  async getVmState(): Promise<"Running" | "Paused" | "Not started"> {
    try {
      const response = await this.request<{ state: string }>("/vm");
      return response.state as "Running" | "Paused" | "Not started";
    } catch {
      return "Not started";
    }
  }

  async isRunning(): Promise<boolean> {
    try {
      const state = await this.getState();
      return state.state === "Running";
    } catch {
      return false;
    }
  }

  async isPaused(): Promise<boolean> {
    try {
      const vmState = await this.getVmState();
      return vmState === "Paused";
    } catch {
      return false;
    }
  }

  async createSnapshot(
    snapshotPath: string,
    memFilePath: string,
  ): Promise<void> {
    await this.pause();
    await this.request("/snapshot/create", {
      method: "PUT",
      body: {
        snapshot_type: "Full",
        snapshot_path: snapshotPath,
        mem_file_path: memFilePath,
      },
    });
  }

  async loadSnapshot(
    snapshotPath: string,
    memFilePath: string,
    options?: {
      enableDiffSnapshots?: boolean;
      networkOverrides?: { iface_id: string; host_dev_name: string }[];
    },
  ): Promise<void> {
    await this.request("/snapshot/load", {
      method: "PUT",
      body: {
        snapshot_path: snapshotPath,
        mem_backend: {
          backend_path: memFilePath,
          backend_type: "File",
        },
        enable_diff_snapshots: options?.enableDiffSnapshots ?? false,
        resume_vm: true,
        network_overrides: options?.networkOverrides,
      },
    });
  }

  async setVsock(guestCid: number, udsPath: string): Promise<void> {
    await this.request("/vsock", {
      method: "PUT",
      body: { guest_cid: guestCid, uds_path: udsPath },
    });
  }
}
