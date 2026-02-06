import * as p from "@clack/prompts";
import { atelierConfig, PATHS } from "../lib/context";

const TEST_TAP = "tap-test";
const TEST_VM_MAC = "06:00:AC:10:00:02";

import { exec, execLive, fileExists } from "../lib/shell";

const VM_NAME = "test-vm";

interface VmPaths {
  socket: string;
  pid: string;
  log: string;
  rootfs: string;
  sshKey: string;
  kernel: string;
}

function getPaths(): VmPaths {
  return {
    socket: `${PATHS.SOCKET_DIR}/${VM_NAME}.sock`,
    pid: `${PATHS.SOCKET_DIR}/${VM_NAME}.pid`,
    log: `${PATHS.LOG_DIR}/${VM_NAME}.log`,
    rootfs: `${PATHS.OVERLAY_DIR}/${VM_NAME}-rootfs.ext4`,
    sshKey: `${PATHS.ROOTFS_DIR}/vm-ssh-key`,
    kernel: `${PATHS.KERNEL_DIR}/vmlinux`,
  };
}

export async function debugVm(args: string[] = []) {
  const subcommand = args[0];

  if (!subcommand) {
    const action = await p.select({
      message: "Debug VM action:",
      options: [
        {
          value: "start",
          label: "Start VM",
          hint: "Boot a debug VM (isolated from Manager)",
        },
        { value: "stop", label: "Stop VM", hint: "Shutdown and cleanup" },
        { value: "status", label: "Status", hint: "Show VM status" },
        { value: "ssh", label: "SSH", hint: "Connect to VM" },
      ],
    });

    if (p.isCancel(action)) {
      p.cancel("Cancelled");
      return;
    }

    await runAction(action);
  } else {
    await runAction(subcommand);
  }
}

async function runAction(action: string) {
  switch (action) {
    case "start":
      await startVm();
      break;
    case "stop":
      await stopVm();
      break;
    case "status":
      await vmStatus();
      break;
    case "ssh":
      await sshToVm();
      break;
    default:
      p.log.error(`Unknown action: ${action}`);
      p.log.info("Available: start, stop, status, ssh");
  }
}

async function startVm() {
  const paths = getPaths();

  if (await fileExists(paths.socket)) {
    p.log.warn("VM might already be running (socket exists)");
    const force = await p.confirm({
      message: "Force restart?",
      initialValue: false,
    });
    if (!p.isCancel(force) && force) {
      await stopVm();
    } else {
      return;
    }
  }

  await checkPrerequisites(paths);

  const spinner = p.spinner();

  spinner.start("Creating TAP device");
  await createTap();
  spinner.stop(
    `TAP ${TEST_TAP} attached to ${atelierConfig.network.bridgeName}`,
  );

  spinner.start("Creating working copy of rootfs");
  await exec(`cp ${PATHS.ROOTFS_DIR}/rootfs.ext4 ${paths.rootfs}`);
  spinner.stop("Rootfs copied");

  spinner.start("Injecting network configuration");
  await injectNetworkConfig(paths.rootfs);
  spinner.stop("Network configured in rootfs");

  spinner.start("Starting Firecracker");
  await exec(
    `mkdir -p ${PATHS.SOCKET_DIR} ${PATHS.LOG_DIR} ${PATHS.OVERLAY_DIR}`,
  );
  await exec(`rm -f ${paths.socket}`);

  const proc = Bun.spawn(
    [
      "/usr/local/bin/firecracker",
      "--api-sock",
      paths.socket,
      "--log-path",
      paths.log,
      "--level",
      "Warning",
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    },
  );

  await Bun.write(paths.pid, String(proc.pid));
  await Bun.sleep(500);

  const alive = await exec(`kill -0 ${proc.pid}`, { throws: false });
  if (!alive.success) {
    spinner.stop("Firecracker failed to start");
    p.log.error(`Check logs: ${paths.log}`);
    throw new Error("Firecracker process died");
  }
  spinner.stop("Firecracker started");

  spinner.start("Configuring VM");
  await configureVm(paths);
  spinner.stop("VM configured");

  spinner.start("Booting VM");
  await exec(
    `curl -s --unix-socket ${paths.socket} -X PUT "http://localhost/actions" \
      -H "Content-Type: application/json" \
      -d '{"action_type": "InstanceStart"}'`,
  );

  await Bun.sleep(2000);

  const stillAlive = await exec(`kill -0 ${proc.pid}`, { throws: false });
  if (!stillAlive.success) {
    spinner.stop("VM crashed after boot");
    p.log.error(`Check logs: ${paths.log}`);
    throw new Error("VM crashed");
  }

  spinner.stop("VM booted");

  p.log.success(`VM started (PID: ${proc.pid})`);
  p.note(
    `Guest IP: ${`${atelierConfig.network.guestSubnet}.2`}
SSH: atelier debug-vm ssh
Stop: atelier debug-vm stop`,
    "Debug VM",
  );
}

async function configureVm(paths: VmPaths) {
  const curlBase = `curl -s --unix-socket ${paths.socket}`;
  const bootArgs = "console=ttyS0 reboot=k panic=1 pci=off";

  await exec(`${curlBase} -X PUT "http://localhost/boot-source" \
    -H "Content-Type: application/json" \
    -d '{"kernel_image_path": "${paths.kernel}", "boot_args": "${bootArgs}"}'`);

  await exec(`${curlBase} -X PUT "http://localhost/drives/rootfs" \
    -H "Content-Type: application/json" \
    -d '{"drive_id": "rootfs", "path_on_host": "${paths.rootfs}", "is_root_device": true, "is_read_only": false}'`);

  await exec(`${curlBase} -X PUT "http://localhost/network-interfaces/eth0" \
    -H "Content-Type: application/json" \
    -d '{"iface_id": "eth0", "guest_mac": "${TEST_VM_MAC}", "host_dev_name": "${TEST_TAP}"}'`);

  await exec(`${curlBase} -X PUT "http://localhost/machine-config" \
    -H "Content-Type: application/json" \
    -d '{"vcpu_count": 2, "mem_size_mib": 1024}'`);

  await Bun.sleep(100);
}

async function stopVm() {
  const paths = getPaths();
  const spinner = p.spinner();

  spinner.start("Stopping VM");

  if (await fileExists(paths.pid)) {
    const pid = (await Bun.file(paths.pid).text()).trim();
    await exec(`kill ${pid} 2>/dev/null || true`);
    await Bun.sleep(500);
    await exec(`kill -9 ${pid} 2>/dev/null || true`);
    await exec(`rm -f ${paths.pid}`);
  }

  await exec(`pkill -f "firecracker.*${VM_NAME}.sock" 2>/dev/null || true`, {
    throws: false,
  });
  await exec(`rm -f ${paths.socket}`);
  await exec(`rm -f ${paths.rootfs}`);

  spinner.stop("VM stopped");

  spinner.start("Cleaning up TAP");
  await exec(`ip link del ${TEST_TAP} 2>/dev/null || true`);
  spinner.stop("TAP removed");

  p.log.success("VM stopped and cleaned up");
}

async function vmStatus() {
  const paths = getPaths();

  const socketExists = await fileExists(paths.socket);
  const pidExists = await fileExists(paths.pid);
  const bridgeExists = (
    await exec(`ip link show ${atelierConfig.network.bridgeName}`, {
      throws: false,
    })
  ).success;
  const tapExists = (await exec(`ip link show ${TEST_TAP}`, { throws: false }))
    .success;
  const pingable = (
    await exec(`ping -c 1 -W 1 ${`${atelierConfig.network.guestSubnet}.2`}`, {
      throws: false,
    })
  ).success;

  let processRunning = false;
  if (pidExists) {
    const pid = (await Bun.file(paths.pid).text()).trim();
    processRunning = (await exec(`kill -0 ${pid}`, { throws: false })).success;
  }

  console.log("");
  console.log("VM Status:");
  console.log("----------");
  console.log(
    `  Bridge:  ${bridgeExists ? `✓ ${atelierConfig.network.bridgeName}` : "✗ not found (run 'atelier network')"}`,
  );
  console.log(`  TAP:     ${tapExists ? `✓ ${TEST_TAP}` : "○ not created"}`);
  console.log(`  Socket:  ${socketExists ? "✓ exists" : "✗ not found"}`);
  console.log(
    `  Process: ${processRunning ? "✓ running" : pidExists ? "✗ dead (stale PID)" : "○ not running"}`,
  );
  console.log(
    `  Guest:   ${pingable ? "✓ reachable" : "○ not reachable"} (${`${atelierConfig.network.guestSubnet}.2`})`,
  );
  console.log("");
}

async function sshToVm() {
  const paths = getPaths();

  if (!(await fileExists(paths.sshKey))) {
    throw new Error(`SSH key not found: ${paths.sshKey}`);
  }

  p.log.info(`Connecting to ${`${atelierConfig.network.guestSubnet}.2`}...`);

  await execLive(
    `ssh -i ${paths.sshKey} \
       -o StrictHostKeyChecking=no \
       -o UserKnownHostsFile=/dev/null \
       root@${`${atelierConfig.network.guestSubnet}.2`}`,
  );
}

async function createTap() {
  await exec(`ip link del ${TEST_TAP} 2>/dev/null || true`);
  await exec(`ip tuntap add dev ${TEST_TAP} mode tap`);
  await exec(
    `ip link set ${TEST_TAP} master ${atelierConfig.network.bridgeName}`,
  );
  await exec(`ip link set dev ${TEST_TAP} up`);
}

async function checkPrerequisites(paths: VmPaths) {
  const bridgeExists = await exec(
    `ip link show ${atelierConfig.network.bridgeName}`,
    {
      throws: false,
    },
  );
  if (!bridgeExists.success) {
    throw new Error(
      `Bridge ${atelierConfig.network.bridgeName} not found. Run 'atelier network' first.`,
    );
  }

  const checks = [
    { path: "/usr/local/bin/firecracker", name: "Firecracker" },
    { path: paths.kernel, name: "Kernel" },
    { path: `${PATHS.ROOTFS_DIR}/rootfs.ext4`, name: "Rootfs" },
  ];

  for (const check of checks) {
    if (!(await fileExists(check.path))) {
      throw new Error(
        `${check.name} not found: ${check.path}. Run 'atelier firecracker' first.`,
      );
    }
  }

  const kvmOk = await exec("test -r /dev/kvm && test -w /dev/kvm", {
    throws: false,
  });
  if (!kvmOk.success) {
    throw new Error("KVM not accessible. Run 'atelier base' first.");
  }
}

async function injectNetworkConfig(rootfsPath: string) {
  const mountPoint = `/tmp/rootfs-mount-${Date.now()}`;

  await exec(`mkdir -p ${mountPoint}`);
  await exec(`mount -o loop ${rootfsPath} ${mountPoint}`);

  try {
    const dnsLines = atelierConfig.network.dnsServers
      .map((dns) => `echo 'nameserver ${dns}' >> /etc/resolv.conf`)
      .join("\n");
    const networkScript = `#!/bin/bash
ip addr add ${`${atelierConfig.network.guestSubnet}.2`}/${atelierConfig.network.bridgeNetmask} dev eth0
ip link set eth0 up
ip route add default via ${atelierConfig.network.bridgeIp} dev eth0
> /etc/resolv.conf
${dnsLines}
`;

    await Bun.write(`${mountPoint}/etc/network-setup.sh`, networkScript);
    await exec(`chmod +x ${mountPoint}/etc/network-setup.sh`);

    const rcLocalPath = `${mountPoint}/etc/rc.local`;
    const rcLocalContent = `#!/bin/bash
/etc/network-setup.sh
exit 0
`;
    await Bun.write(rcLocalPath, rcLocalContent);
    await exec(`chmod +x ${rcLocalPath}`);

    const hasSystemd = await exec(`test -d ${mountPoint}/etc/systemd/system`, {
      throws: false,
    });

    if (hasSystemd.success) {
      const systemdServicePath = `${mountPoint}/etc/systemd/system/network-setup.service`;
      const serviceContent = `[Unit]
Description=Configure network for sandbox
After=network.target

[Service]
Type=oneshot
ExecStart=/etc/network-setup.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`;
      await Bun.write(systemdServicePath, serviceContent);
      await exec(
        `ln -sf /etc/systemd/system/network-setup.service ${mountPoint}/etc/systemd/system/multi-user.target.wants/network-setup.service`,
      );
    }
  } finally {
    await exec(`umount ${mountPoint}`);
    await exec(`rmdir ${mountPoint}`);
  }
}
