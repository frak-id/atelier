import * as p from "@clack/prompts";
import { loadConfig } from "@frak-sandbox/shared";
import { frakConfig, PATHS } from "../lib/context";
import { exec } from "../lib/shell";

const SYSTEMD_SERVICE_PATH = "/etc/systemd/system/sandbox-network.service";
const NETWORK_SCRIPT_PATH = `${PATHS.APP_DIR}/infra/scripts/configure-network.sh`;

export async function setupNetwork(_args: string[] = []) {
  p.log.step("Network Setup: Persistent Bridge");

  const bridgeExists = await exec(
    `ip link show ${frakConfig.network.bridgeName}`,
    {
      throws: false,
    },
  );

  if (bridgeExists.success) {
    p.log.warn(`Bridge '${frakConfig.network.bridgeName}' already exists`);
    await showNetworkStatus();

    const setupConfig = await loadNetworkSetupConfig();
    const configAction = setupConfig?.onExists;

    if (configAction === "status") {
      return;
    }

    if (configAction === "recreate") {
      await destroyBridge();
    } else {
      const action = await p.select({
        message:
          "Network bridge already configured. What would you like to do?",
        options: [
          { value: "status", label: "Show status only" },
          {
            value: "recreate",
            label: "Recreate bridge",
            hint: "Destroys existing bridge",
          },
        ],
      });

      if (p.isCancel(action) || action === "status") {
        return;
      }

      if (action === "recreate") {
        await destroyBridge();
      }
    }
  }

  const spinner = p.spinner();

  spinner.start("Creating bridge interface");
  await createBridge();
  spinner.stop(`Bridge ${frakConfig.network.bridgeName} created`);

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
  await exec(`ip link add name ${frakConfig.network.bridgeName} type bridge`);
  await exec(
    `ip addr add ${frakConfig.network.bridgeIp}/${frakConfig.network.bridgeNetmask} dev ${frakConfig.network.bridgeName}`,
  );
  await exec(`ip link set dev ${frakConfig.network.bridgeName} up`);
}

async function configureNat() {
  await exec("echo 1 > /proc/sys/net/ipv4/ip_forward");

  await exec(
    'grep -q "^net.ipv4.ip_forward=1" /etc/sysctl.conf || echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf',
  );

  const { stdout: hostIface } = await exec(
    "ip -j route list default | jq -r '.[0].dev'",
  );

  await exec(
    `iptables -C FORWARD -i ${frakConfig.network.bridgeName} -o ${frakConfig.network.bridgeName} -s ${frakConfig.network.bridgeCidr} -d ${frakConfig.network.bridgeCidr} -j DROP 2>/dev/null || \
     iptables -I FORWARD 1 -i ${frakConfig.network.bridgeName} -o ${frakConfig.network.bridgeName} -s ${frakConfig.network.bridgeCidr} -d ${frakConfig.network.bridgeCidr} -j DROP`,
  );

  await exec(
    `iptables -t nat -C POSTROUTING -s ${frakConfig.network.bridgeCidr} -o ${hostIface} -j MASQUERADE 2>/dev/null || \
     iptables -t nat -A POSTROUTING -s ${frakConfig.network.bridgeCidr} -o ${hostIface} -j MASQUERADE`,
  );

  await exec(
    `iptables -C FORWARD -i ${frakConfig.network.bridgeName} -o ${hostIface} -j ACCEPT 2>/dev/null || \
     iptables -A FORWARD -i ${frakConfig.network.bridgeName} -o ${hostIface} -j ACCEPT`,
  );
  await exec(
    `iptables -C FORWARD -i ${hostIface} -o ${frakConfig.network.bridgeName} -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
     iptables -A FORWARD -i ${hostIface} -o ${frakConfig.network.bridgeName} -m state --state RELATED,ESTABLISHED -j ACCEPT`,
  );
}

async function installSystemdService() {
  const scriptContent = `#!/bin/bash
set -e

BRIDGE="${frakConfig.network.bridgeName}"
BRIDGE_IP="${frakConfig.network.bridgeIp}"
BRIDGE_CIDR="${frakConfig.network.bridgeCidr}"

if ! ip link show "$BRIDGE" &>/dev/null; then
  ip link add name "$BRIDGE" type bridge
  ip addr add "$BRIDGE_IP/${frakConfig.network.bridgeNetmask}" dev "$BRIDGE"
  ip link set dev "$BRIDGE" up
fi

echo 1 > /proc/sys/net/ipv4/ip_forward

HOST_IFACE=$(ip -j route list default | jq -r '.[0].dev')

iptables -C FORWARD -i "$BRIDGE" -o "$BRIDGE" -s "$BRIDGE_CIDR" -d "$BRIDGE_CIDR" -j DROP 2>/dev/null || \\
  iptables -I FORWARD 1 -i "$BRIDGE" -o "$BRIDGE" -s "$BRIDGE_CIDR" -d "$BRIDGE_CIDR" -j DROP

iptables -t nat -C POSTROUTING -s "$BRIDGE_CIDR" -o "$HOST_IFACE" -j MASQUERADE 2>/dev/null || \\
  iptables -t nat -A POSTROUTING -s "$BRIDGE_CIDR" -o "$HOST_IFACE" -j MASQUERADE

iptables -C FORWARD -i "$BRIDGE" -o "$HOST_IFACE" -j ACCEPT 2>/dev/null || \\
  iptables -A FORWARD -i "$BRIDGE" -o "$HOST_IFACE" -j ACCEPT

iptables -C FORWARD -i "$HOST_IFACE" -o "$BRIDGE" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \\
  iptables -A FORWARD -i "$HOST_IFACE" -o "$BRIDGE" -m state --state RELATED,ESTABLISHED -j ACCEPT

echo "Sandbox network configured"
`;

  const serviceContent = `[Unit]
Description=Sandbox Network Bridge
After=network.target
Before=frak-sandbox-manager.service

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
    `ip link show master ${frakConfig.network.bridgeName} 2>/dev/null | grep -oP '^\\d+: \\K[^:@]+' || true`,
    { throws: false },
  );

  for (const tap of taps.split("\n").filter(Boolean)) {
    await exec(`ip link del ${tap}`, { throws: false });
  }

  await exec(`ip link del ${frakConfig.network.bridgeName}`, { throws: false });

  spinner.stop("Bridge destroyed");
}

async function showNetworkStatus() {
  p.log.info("Network Status:");

  const bridgeInfo = await exec(
    `ip addr show ${frakConfig.network.bridgeName}`,
    {
      throws: false,
    },
  );
  if (bridgeInfo.success) {
    console.log(bridgeInfo.stdout);
  }

  console.log("");

  const { stdout: attachedTaps } = await exec(
    `ip link show master ${frakConfig.network.bridgeName} 2>/dev/null | grep -oP '^\\d+: \\K[^:@]+' || echo "None"`,
    { throws: false },
  );
  console.log(
    `Attached TAPs: ${attachedTaps.split("\n").filter(Boolean).join(", ") || "None"}`,
  );

  console.log("");

  const serviceStatus = await exec(
    "systemctl is-enabled sandbox-network.service",
    { throws: false },
  );
  console.log(
    `Systemd service: ${serviceStatus.success ? "enabled" : "not installed"}`,
  );

  console.log("");
  p.note(
    `Bridge: ${frakConfig.network.bridgeName} (${frakConfig.network.bridgeIp}/${frakConfig.network.bridgeNetmask})
Guest IPs: ${frakConfig.network.guestSubnet}.${frakConfig.network.guestIpStart}+
Test VM IP: ${frakConfig.network.guestSubnet}.2`,
    "Network Info",
  );
}

type NetworkSetupConfig = {
  onExists?: "status" | "recreate";
};

async function loadNetworkSetupConfig(): Promise<NetworkSetupConfig | null> {
  const config = loadConfig();
  const network = config.setup?.network;

  if (!network) return null;

  const onExistsRaw = network.onExists;
  const onExists =
    onExistsRaw === "status" || onExistsRaw === "recreate"
      ? onExistsRaw
      : undefined;

  if (!onExists) return null;
  return { onExists };
}
