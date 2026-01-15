export const PATHS = {
  SANDBOX_DIR: "/var/lib/sandbox",
  KERNEL_DIR: "/var/lib/sandbox/firecracker/kernels",
  ROOTFS_DIR: "/var/lib/sandbox/firecracker/rootfs",
  OVERLAY_DIR: "/var/lib/sandbox/overlays",
  SOCKET_DIR: "/var/lib/sandbox/sockets",
  LOG_DIR: "/var/log/sandbox",
  APP_DIR: "/opt/frak-sandbox",
} as const;

export const FIRECRACKER = {
  VERSION: "1.10.1",
  RELEASE_URL: "https://github.com/firecracker-microvm/firecracker/releases",
  S3_BUCKET: "https://s3.amazonaws.com/spec.ccfc.min",
} as const;

export const NETWORK = {
  BRIDGE_NAME: "br0",
  BRIDGE_IP: "172.16.0.1",
  BRIDGE_CIDR: "172.16.0.0/24",
  BRIDGE_NETMASK: "24",
  GUEST_IP_START: 10,
  GUEST_SUBNET: "172.16.0",
  TEST_VM_IP: "172.16.0.2",
  TEST_VM_MAC: "06:00:AC:10:00:02",
  TEST_TAP: "tap-test",
} as const;

export const LVM = {
  VG_NAME: "sandbox-vg",
  THIN_POOL: "thin-pool",
  BASE_VOLUME: "base-rootfs",
  BASE_SIZE: "2G",
} as const;
