import * as p from "@clack/prompts";
import { loadConfig } from "@frak/atelier-shared";
import { atelierConfig, PATHS } from "../lib/context";
import { exec } from "../lib/shell";

const SYSTEMD_SERVICE_PATH = "/etc/systemd/system/sandbox-network.service";
const NETWORK_SCRIPT_PATH = `${PATHS.APP_DIR}/infra/scripts/configure-network.sh`;

export async function setupNetwork(_args: string[] = []) {
  p.log.step("Network Setup: Persistent Bridge");

  const bridgeExists = await exec(
    `ip link show ${atelierConfig.network.bridgeName}`,
    {
      throws: false,
    },
  );

  if (bridgeExists.success) {
    p.log.warn(`Bridge '${atelierConfig.network.bridgeName}' already exists`);
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
  spinner.stop(`Bridge ${atelierConfig.network.bridgeName} created`);

  spinner.start("Configuring NAT");
  await configureNat();
  spinner.stop("NAT configured");

  spinner.start("Configuring UFW (if active)");
  await configureUfw();
  spinner.stop("UFW configured");

  spinner.start("Installing systemd service");
  await installSystemdService();
  spinner.stop("Systemd service installed");

  p.log.success("Network setup complete");
  await showNetworkStatus();
}

async function createBridge() {
  await exec(
    `ip link add name ${atelierConfig.network.bridgeName} type bridge`,
  );
  await exec(
    `ip addr add ${atelierConfig.network.bridgeIp}/${atelierConfig.network.bridgeNetmask} dev ${atelierConfig.network.bridgeName}`,
  );
  await exec(`ip link set dev ${atelierConfig.network.bridgeName} up`);
}

async function configureNat() {
  await exec("echo 1 > /proc/sys/net/ipv4/ip_forward");

  await exec(
    'grep -q "^net.ipv4.ip_forward=1" /etc/sysctl.conf || echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf',
  );

  const { stdout: hostIface } = await exec(
    "ip -j route list default | jq -r '.[0].dev // empty'",
  );

  if (!hostIface.trim() || hostIface.trim() === "null") {
    throw new Error(
      `Could not detect host network interface. 'ip route list default' returned: '${hostIface.trim()}'`,
    );
  }

  await exec(
    `iptables -C FORWARD -i ${atelierConfig.network.bridgeName} -o ${atelierConfig.network.bridgeName} -s ${atelierConfig.network.bridgeCidr} -d ${atelierConfig.network.bridgeCidr} -j DROP 2>/dev/null || \
      iptables -I FORWARD 1 -i ${atelierConfig.network.bridgeName} -o ${atelierConfig.network.bridgeName} -s ${atelierConfig.network.bridgeCidr} -d ${atelierConfig.network.bridgeCidr} -j DROP`,
  );

  await exec(
    `iptables -t nat -C POSTROUTING -s ${atelierConfig.network.bridgeCidr} -o ${hostIface} -j MASQUERADE 2>/dev/null || \
      iptables -t nat -A POSTROUTING -s ${atelierConfig.network.bridgeCidr} -o ${hostIface} -j MASQUERADE`,
  );

  await exec(
    `iptables -C FORWARD -i ${atelierConfig.network.bridgeName} -o ${hostIface} -j ACCEPT 2>/dev/null || \
      iptables -A FORWARD -i ${atelierConfig.network.bridgeName} -o ${hostIface} -j ACCEPT`,
  );
  await exec(
    `iptables -C FORWARD -i ${hostIface} -o ${atelierConfig.network.bridgeName} -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
      iptables -A FORWARD -i ${hostIface} -o ${atelierConfig.network.bridgeName} -m state --state RELATED,ESTABLISHED -j ACCEPT`,
  );
}

async function isUfwActive(): Promise<boolean> {
  const result = await exec("ufw status", { throws: false });
  return result.success && result.stdout.includes("Status: active");
}

async function configureUfw() {
  if (!(await isUfwActive())) return;

  const { stdout: hostIface } = await exec(
    "ip -j route list default | jq -r '.[0].dev // empty'",
  );
  const iface = hostIface.trim();
  if (!iface || iface === "null") return;

  const bridge = atelierConfig.network.bridgeName;

  // Allow forwarding from bridge to host interface (outbound VM traffic)
  await exec(`ufw route allow in on ${bridge} out on ${iface}`, {
    throws: false,
  });

  // Allow return traffic from host interface to bridge
  await exec(`ufw route allow in on ${iface} out on ${bridge}`, {
    throws: false,
  });
}

async function installSystemdService() {
  const scriptContent = `#!/bin/bash
set -e

BRIDGE="${atelierConfig.network.bridgeName}"
BRIDGE_IP="${atelierConfig.network.bridgeIp}"
BRIDGE_CIDR="${atelierConfig.network.bridgeCidr}"

if ! ip link show "$BRIDGE" &>/dev/null; then
   ip link add name "$BRIDGE" type bridge
   ip addr add "$BRIDGE_IP/${atelierConfig.network.bridgeNetmask}" dev "$BRIDGE"
   ip link set dev "$BRIDGE" up
fi

echo 1 > /proc/sys/net/ipv4/ip_forward

# Wait for default route (network-online.target may fire before route is ready)
for i in $(seq 1 30); do
  HOST_IFACE=$(ip -j route list default 2>/dev/null | jq -r '.[0].dev // empty')
  if [ -n "$HOST_IFACE" ] && [ "$HOST_IFACE" != "null" ]; then
    break
  fi
  echo "Waiting for default route... ($i/30)"
  sleep 1
done

if [ -z "$HOST_IFACE" ] || [ "$HOST_IFACE" = "null" ]; then
  echo "ERROR: No default route found after 30s. Cannot configure NAT." >&2
  exit 1
fi

echo "Using host interface: $HOST_IFACE"

iptables -C FORWARD -i "$BRIDGE" -o "$BRIDGE" -s "$BRIDGE_CIDR" -d "$BRIDGE_CIDR" -j DROP 2>/dev/null || \\
  iptables -I FORWARD 1 -i "$BRIDGE" -o "$BRIDGE" -s "$BRIDGE_CIDR" -d "$BRIDGE_CIDR" -j DROP

iptables -t nat -C POSTROUTING -s "$BRIDGE_CIDR" -o "$HOST_IFACE" -j MASQUERADE 2>/dev/null || \\
  iptables -t nat -A POSTROUTING -s "$BRIDGE_CIDR" -o "$HOST_IFACE" -j MASQUERADE

iptables -C FORWARD -i "$BRIDGE" -o "$HOST_IFACE" -j ACCEPT 2>/dev/null || \\
  iptables -A FORWARD -i "$BRIDGE" -o "$HOST_IFACE" -j ACCEPT

iptables -C FORWARD -i "$HOST_IFACE" -o "$BRIDGE" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \\
  iptables -A FORWARD -i "$HOST_IFACE" -o "$BRIDGE" -m state --state RELATED,ESTABLISHED -j ACCEPT


# Configure UFW forwarding rules if UFW is active
if ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw route allow in on "$BRIDGE" out on "$HOST_IFACE" 2>/dev/null || true
  ufw route allow in on "$HOST_IFACE" out on "$BRIDGE" 2>/dev/null || true
  echo "UFW route rules configured for $BRIDGE <-> $HOST_IFACE"
fi

echo "Sandbox network configured (interface: $HOST_IFACE)"
`;

  const serviceContent = `[Unit]
Description=Sandbox Network Bridge
After=network-online.target
Wants=network-online.target
Before=atelier-manager.service

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
    `ip link show master ${atelierConfig.network.bridgeName} 2>/dev/null | grep -oP '^\\d+: \\K[^:@]+' || true`,
    { throws: false },
  );

  for (const tap of taps.split("\n").filter(Boolean)) {
    await exec(`ip link del ${tap}`, { throws: false });
  }

  await exec(`ip link del ${atelierConfig.network.bridgeName}`, {
    throws: false,
  });

  spinner.stop("Bridge destroyed");
}

async function showNetworkStatus() {
  p.log.info("Network Status:");

  const bridgeInfo = await exec(
    `ip addr show ${atelierConfig.network.bridgeName}`,
    {
      throws: false,
    },
  );
  if (bridgeInfo.success) {
    console.log(bridgeInfo.stdout);
  }

  console.log("");

  const { stdout: attachedTaps } = await exec(
    `ip link show master ${atelierConfig.network.bridgeName} 2>/dev/null | grep -oP '^\\d+: \\K[^:@]+' || echo "None"`,
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
    `Bridge: ${atelierConfig.network.bridgeName} (${atelierConfig.network.bridgeIp}/${atelierConfig.network.bridgeNetmask})
Guest IPs: ${atelierConfig.network.guestSubnet}.${atelierConfig.network.guestIpStart}+
Test VM IP: ${atelierConfig.network.guestSubnet}.2`,
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
