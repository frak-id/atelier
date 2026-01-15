import * as p from "@clack/prompts";
import { exec } from "../lib/shell";
import { NETWORK, PATHS } from "../lib/context";

const SYSTEMD_SERVICE_PATH = "/etc/systemd/system/sandbox-network.service";
const NETWORK_SCRIPT_PATH = `${PATHS.APP_DIR}/infra/scripts/configure-network.sh`;

export async function setupNetwork(_args: string[] = []) {
  p.log.step("Network Setup: Persistent Bridge");

  const bridgeExists = await exec(`ip link show ${NETWORK.BRIDGE_NAME}`, {
    throws: false,
  });

  if (bridgeExists.success) {
    p.log.warn(`Bridge '${NETWORK.BRIDGE_NAME}' already exists`);
    await showNetworkStatus();

    const action = await p.select({
      message: "Network bridge already configured. What would you like to do?",
      options: [
        { value: "status", label: "Show status only" },
        { value: "recreate", label: "Recreate bridge", hint: "Destroys existing bridge" },
      ],
    });

    if (p.isCancel(action) || action === "status") {
      return;
    }

    if (action === "recreate") {
      await destroyBridge();
    }
  }

  const spinner = p.spinner();

  spinner.start("Creating bridge interface");
  await createBridge();
  spinner.stop(`Bridge ${NETWORK.BRIDGE_NAME} created`);

  spinner.start("Configuring NAT");
  await configureNat();
  spinner.stop("NAT configured");

  spinner.start("Installing systemd service");
  await installSystemdService();
  spinner.stop("Systemd service installed");

  p.log.success("Network setup complete");
  await showNetworkStatus();
}

async function createBridge() {
  await exec(`ip link add name ${NETWORK.BRIDGE_NAME} type bridge`);
  await exec(`ip addr add ${NETWORK.BRIDGE_IP}/${NETWORK.BRIDGE_NETMASK} dev ${NETWORK.BRIDGE_NAME}`);
  await exec(`ip link set dev ${NETWORK.BRIDGE_NAME} up`);
}

async function configureNat() {
  await exec("echo 1 > /proc/sys/net/ipv4/ip_forward");

  await exec(
    'grep -q "^net.ipv4.ip_forward=1" /etc/sysctl.conf || echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf'
  );

  const { stdout: hostIface } = await exec("ip -j route list default | jq -r '.[0].dev'");

  await exec(
    `iptables -t nat -C POSTROUTING -s ${NETWORK.BRIDGE_CIDR} -o ${hostIface} -j MASQUERADE 2>/dev/null || \
     iptables -t nat -A POSTROUTING -s ${NETWORK.BRIDGE_CIDR} -o ${hostIface} -j MASQUERADE`
  );

  await exec(
    `iptables -C FORWARD -i ${NETWORK.BRIDGE_NAME} -o ${hostIface} -j ACCEPT 2>/dev/null || \
     iptables -A FORWARD -i ${NETWORK.BRIDGE_NAME} -o ${hostIface} -j ACCEPT`
  );
  await exec(
    `iptables -C FORWARD -i ${hostIface} -o ${NETWORK.BRIDGE_NAME} -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
     iptables -A FORWARD -i ${hostIface} -o ${NETWORK.BRIDGE_NAME} -m state --state RELATED,ESTABLISHED -j ACCEPT`
  );
}

async function installSystemdService() {
  const scriptContent = `#!/bin/bash
set -e

BRIDGE="${NETWORK.BRIDGE_NAME}"
BRIDGE_IP="${NETWORK.BRIDGE_IP}"
BRIDGE_CIDR="${NETWORK.BRIDGE_CIDR}"

if ! ip link show "\$BRIDGE" &>/dev/null; then
  ip link add name "\$BRIDGE" type bridge
  ip addr add "\$BRIDGE_IP/${NETWORK.BRIDGE_NETMASK}" dev "\$BRIDGE"
  ip link set dev "\$BRIDGE" up
fi

echo 1 > /proc/sys/net/ipv4/ip_forward

HOST_IFACE=$(ip -j route list default | jq -r '.[0].dev')

iptables -t nat -C POSTROUTING -s "\$BRIDGE_CIDR" -o "\$HOST_IFACE" -j MASQUERADE 2>/dev/null || \\
  iptables -t nat -A POSTROUTING -s "\$BRIDGE_CIDR" -o "\$HOST_IFACE" -j MASQUERADE

iptables -C FORWARD -i "\$BRIDGE" -o "\$HOST_IFACE" -j ACCEPT 2>/dev/null || \\
  iptables -A FORWARD -i "\$BRIDGE" -o "\$HOST_IFACE" -j ACCEPT

iptables -C FORWARD -i "\$HOST_IFACE" -o "\$BRIDGE" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \\
  iptables -A FORWARD -i "\$HOST_IFACE" -o "\$BRIDGE" -m state --state RELATED,ESTABLISHED -j ACCEPT

echo "Sandbox network configured"
`;

  const serviceContent = `[Unit]
Description=Sandbox Network Bridge
After=network.target
Before=sandbox-manager.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${NETWORK_SCRIPT_PATH}

[Install]
WantedBy=multi-user.target
`;

  await exec(`mkdir -p ${PATHS.APP_DIR}/infra/scripts`);
  await Bun.write(NETWORK_SCRIPT_PATH, scriptContent);
  await exec(`chmod +x ${NETWORK_SCRIPT_PATH}`);

  await Bun.write(SYSTEMD_SERVICE_PATH, serviceContent);
  await exec("systemctl daemon-reload");
  await exec("systemctl enable sandbox-network.service");

  p.log.info("Service enabled: sandbox-network.service");
}

async function destroyBridge() {
  const spinner = p.spinner();
  spinner.start("Destroying existing bridge");

  const { stdout: taps } = await exec(
    `ip link show master ${NETWORK.BRIDGE_NAME} 2>/dev/null | grep -oP '^\\d+: \\K[^:@]+' || true`,
    { throws: false }
  );

  for (const tap of taps.split("\n").filter(Boolean)) {
    await exec(`ip link del ${tap}`, { throws: false });
  }

  await exec(`ip link del ${NETWORK.BRIDGE_NAME}`, { throws: false });

  spinner.stop("Bridge destroyed");
}

async function showNetworkStatus() {
  p.log.info("Network Status:");

  const bridgeInfo = await exec(`ip addr show ${NETWORK.BRIDGE_NAME}`, { throws: false });
  if (bridgeInfo.success) {
    console.log(bridgeInfo.stdout);
  }

  console.log("");

  const { stdout: attachedTaps } = await exec(
    `ip link show master ${NETWORK.BRIDGE_NAME} 2>/dev/null | grep -oP '^\\d+: \\K[^:@]+' || echo "None"`,
    { throws: false }
  );
  console.log(`Attached TAPs: ${attachedTaps.split("\n").filter(Boolean).join(", ") || "None"}`);

  console.log("");

  const serviceStatus = await exec("systemctl is-enabled sandbox-network.service", { throws: false });
  console.log(`Systemd service: ${serviceStatus.success ? "enabled" : "not installed"}`);

  console.log("");
  p.note(
    `Bridge: ${NETWORK.BRIDGE_NAME} (${NETWORK.BRIDGE_IP}/${NETWORK.BRIDGE_NETMASK})
Guest IPs: ${NETWORK.GUEST_SUBNET}.${NETWORK.GUEST_IP_START}+
Test VM IP: ${NETWORK.TEST_VM_IP}`,
    "Network Info"
  );
}
