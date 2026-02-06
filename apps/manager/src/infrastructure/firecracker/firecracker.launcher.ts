import { FIRECRACKER, PATHS } from "@frak/atelier-shared/constants";
import { $ } from "bun";
import { ensureDir } from "../../shared/lib/shell.ts";
import { BINARIES_IMAGE_PATH, SharedStorageService } from "../storage/index.ts";
import { FirecrackerClient } from "./firecracker.client.ts";
import type { SandboxPaths } from "./firecracker.paths.ts";

export interface VmConfigOptions {
  paths: SandboxPaths;
  macAddress: string;
  tapDevice: string;
  vcpus: number;
  memoryMb: number;
}

export async function launchFirecracker(
  paths: SandboxPaths,
): Promise<{ pid: number; client: FirecrackerClient }> {
  await Promise.all([ensureDir(PATHS.SOCKET_DIR), ensureDir(PATHS.LOG_DIR)]);

  await Promise.all([
    $`rm -f ${paths.socket}`.quiet().nothrow(),
    Bun.write(paths.log, ""),
  ]);

  const proc = Bun.spawn(
    [
      FIRECRACKER.BINARY_PATH,
      "--api-sock",
      paths.socket,
      "--log-path",
      paths.log,
      "--level",
      "Warning",
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );

  await Bun.write(paths.pid, String(proc.pid));
  await Bun.sleep(50);

  if (!proc.pid || proc.exitCode !== null) {
    const logContent = await Bun.file(paths.log)
      .text()
      .catch(() => "");
    throw new Error(`Firecracker process died on startup: ${logContent}`);
  }

  const client = new FirecrackerClient(paths.socket);
  return { pid: proc.pid, client };
}

export async function configureVm(
  client: FirecrackerClient,
  options: VmConfigOptions,
): Promise<void> {
  const bootArgs =
    "console=ttyS0 reboot=k panic=1 pci=off quiet loglevel=1 8250.nr_uarts=0 init=/etc/sandbox/sandbox-init.sh";

  await client.setBootSource(options.paths.kernel, bootArgs);
  await client.setDrive("rootfs", options.paths.overlay, true);

  const imageInfo = await SharedStorageService.getBinariesImageInfo();
  if (imageInfo.exists) {
    await client.setDrive("shared", BINARIES_IMAGE_PATH, false, true);
  }

  await client.setNetworkInterface(
    "eth0",
    options.macAddress,
    options.tapDevice,
  );

  const cpuTemplatePath = `${PATHS.SANDBOX_DIR}/cpu-template-no-avx.json`;
  await client.setCpuConfig(cpuTemplatePath);

  await client.setMachineConfig(options.vcpus, options.memoryMb);

  await client.setVsock(3, options.paths.vsock);
}
