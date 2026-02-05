import * as p from "@clack/prompts";
import { PATHS } from "../lib/context";
import { commandExists, exec } from "../lib/shell";

export async function baseSetup(_args: string[] = []) {
  p.log.step("Phase 1.1: Base Setup");

  const spinner = p.spinner();

  spinner.start("Checking system packages");
  const missingPkgs = await getMissingPackages();
  if (missingPkgs.length > 0) {
    spinner.message("Updating package lists");
    await exec("apt-get update -qq");
    spinner.message(`Installing ${missingPkgs.length} packages`);
    await exec(
      `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${missingPkgs.join(" ")}`,
    );
    spinner.stop("Essential packages installed");
  } else {
    spinner.stop("Essential packages already installed");
  }

  const bunSystem = await exec("test -x /usr/local/bin/bun", {
    throws: false,
  });
  const bunRoot = await exec("test -x /root/.bun/bin/bun", { throws: false });

  if (bunSystem.success || bunRoot.success) {
    const { stdout } = await exec(
      "/usr/local/bin/bun --version 2>/dev/null || /root/.bun/bin/bun --version 2>/dev/null || bun --version",
      { throws: false },
    );
    p.log.success(`Bun already installed: v${stdout}`);

    if (!bunSystem.success && bunRoot.success) {
      spinner.start("Linking Bun to /usr/local/bin");
      await exec("install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun");
      spinner.stop("Bun linked to /usr/local/bin");
    }
  } else {
    spinner.start("Installing Bun");
    await exec(
      "curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash",
    );
    const bunLocal = await exec("test -x /usr/local/bin/bun", {
      throws: false,
    });
    if (!bunLocal.success) {
      const bunAlt = await exec("test -x /usr/local/bun/bin/bun", {
        throws: false,
      });
      if (bunAlt.success) {
        await exec("ln -sf /usr/local/bun/bin/bun /usr/local/bin/bun");
      }
    }
    spinner.stop("Bun installed");
  }

  if (await commandExists("docker")) {
    const { stdout } = await exec("docker --version");
    p.log.success(`Docker already installed: ${stdout}`);
  } else {
    spinner.start("Installing Docker");
    await exec("install -m 0755 -d /etc/apt/keyrings");
    await exec(
      "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg",
    );
    await exec("chmod a+r /etc/apt/keyrings/docker.gpg");

    const { stdout: codename } = await exec("lsb_release -cs");
    const arch = (await exec("dpkg --print-architecture")).stdout;

    await exec(`echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/ubuntu ${codename} stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null`);

    await exec("apt-get update -qq");
    await exec(
      "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin",
    );
    await exec("systemctl start docker");
    await exec("systemctl enable docker");
    spinner.stop("Docker installed");
  }

  if (await commandExists("caddy")) {
    const { stdout } = await exec("caddy version");
    p.log.success(`Caddy already installed: ${stdout.split(" ")[0]}`);
  } else {
    spinner.start("Installing Caddy");
    await exec(
      "apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl",
    );
    await exec(
      "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg",
    );
    await exec(
      "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list",
    );
    await exec("apt-get update -qq");
    await exec("apt-get install -y -qq caddy");
    await exec("systemctl stop caddy"); // Don't start yet, needs config
    spinner.stop("Caddy installed");
  }

  spinner.start("Verifying KVM support");
  const kvmLoaded = await exec("lsmod | grep kvm", { throws: false });

  if (!kvmLoaded.success) {
    spinner.message("Loading KVM modules");
    await exec("modprobe kvm", { throws: false });

    const cpuInfo = await exec("cat /proc/cpuinfo");
    if (cpuInfo.stdout.includes("Intel")) {
      await exec("modprobe kvm_intel", { throws: false });
    } else if (cpuInfo.stdout.includes("AMD")) {
      await exec("modprobe kvm_amd", { throws: false });
    }
  }

  const kvmExists = await exec("test -c /dev/kvm", { throws: false });
  if (!kvmExists.success) {
    spinner.stop("KVM verification failed");
    throw new Error(
      "/dev/kvm not found. Ensure this is a bare metal server with VT-x/AMD-V enabled.",
    );
  }

  // Create atelier group with GID 1000 (matches guest 'dev' group)
  await exec(
    "getent group atelier >/dev/null 2>&1 || groupadd --gid 1000 atelier",
    {
      throws: false,
    },
  );
  await exec("getent group kvm >/dev/null 2>&1 || groupadd kvm", {
    throws: false,
  });

  // Create atelier user with UID 1000 (matches guest 'dev' user)
  const atelierExists = await exec("id -u atelier 2>/dev/null", {
    throws: false,
  });
  if (!atelierExists.success) {
    await exec(
      "useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash atelier",
      { throws: false },
    );
  } else {
    // Verify UID is 1000
    const atelierUid = atelierExists.stdout.trim();
    if (atelierUid !== "1000") {
      p.log.warn(
        `atelier user exists with UID ${atelierUid}, expected 1000. Consider recreating instance.`,
      );
    }
  }
  await exec("usermod -aG kvm,disk atelier", { throws: false });
  await exec("chgrp kvm /dev/kvm 2>/dev/null || true", { throws: false });
  await exec("chmod 660 /dev/kvm 2>/dev/null || true", { throws: false });
  spinner.stop("KVM verified and accessible");

  const dirsExist = await exec(`test -d ${PATHS.SANDBOX_DIR}/sockets`, {
    throws: false,
  });
  if (dirsExist.success) {
    p.log.success("Directory structure already exists");
  } else {
    spinner.start("Creating directory structure");
    const dirs = [
      PATHS.SANDBOX_DIR,
      `${PATHS.SANDBOX_DIR}/firecracker`,
      `${PATHS.SANDBOX_DIR}/overlays`,
      `${PATHS.SANDBOX_DIR}/git-cache`,
      `${PATHS.SANDBOX_DIR}/secrets`,
      `${PATHS.SANDBOX_DIR}/sockets`,
      PATHS.KERNEL_DIR,
      PATHS.ROOTFS_DIR,
      PATHS.LOG_DIR,
      PATHS.APP_DIR,
    ];
    await exec(`mkdir -p ${dirs.join(" ")}`);
    await exec(`chmod 755 ${PATHS.SANDBOX_DIR}`);
    await exec(`chmod 700 ${PATHS.SANDBOX_DIR}/secrets`);
    spinner.stop("Directory structure created");
  }

  await exec(`mkdir -p /etc/atelier`);
  await exec(
    `chown -R atelier:atelier ${PATHS.SANDBOX_DIR} ${PATHS.LOG_DIR} ${PATHS.APP_DIR}`,
    {
      throws: false,
    },
  );
  await exec("chgrp -R atelier /etc/atelier", { throws: false });
  await exec("chmod 750 /etc/atelier", { throws: false });

  const sudoersPath = "/etc/sudoers.d/atelier";
  const sudoersContent = `atelier ALL=(root) NOPASSWD: \\
   /usr/sbin/lvcreate, /usr/sbin/lvremove, /usr/sbin/lvextend, /usr/sbin/lvs, \\
   /usr/sbin/mkfs.ext4, /bin/chown, /bin/chmod, /bin/mkdir, /usr/bin/tee, \\
   /sbin/ip, /sbin/bridge, /usr/sbin/bridge, \\
   /usr/bin/mount, /usr/bin/umount, /usr/bin/ln, /usr/bin/rm
`;
  await Bun.write(sudoersPath, sudoersContent);
  await exec(`chmod 440 ${sudoersPath}`);

  const ipForward = await exec("cat /proc/sys/net/ipv4/ip_forward", {
    throws: false,
  });
  if (ipForward.stdout === "1") {
    p.log.success("IP forwarding already enabled");
  } else {
    spinner.start("Enabling IP forwarding");
    await exec("echo 1 > /proc/sys/net/ipv4/ip_forward");
    await exec(
      'grep -q "^net.ipv4.ip_forward=1" /etc/sysctl.conf || echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf',
    );
    await exec("sysctl -p > /dev/null 2>&1", { throws: false });
    spinner.stop("IP forwarding enabled");
  }

  p.log.success("Base setup complete");
  p.note(
    `Installed: essential packages, Bun, Docker, Caddy
Verified: KVM support
Created: ${PATHS.SANDBOX_DIR}
User: atelier (sudoers + kvm)`,
    "Summary",
  );
}

const REQUIRED_PACKAGES = [
  "curl",
  "wget",
  "git",
  "jq",
  "htop",
  "tree",
  "unzip",
  "tar",
  "ca-certificates",
  "gnupg",
  "lsb-release",
  "sudo",
  "acl",
  "e2fsprogs",
  "squashfs-tools",
  "lvm2",
  "thin-provisioning-tools",
  "iproute2",
  "iptables",
  "bridge-utils",
  "net-tools",
  "file",
];

async function getMissingPackages(): Promise<string[]> {
  const missing: string[] = [];

  for (const pkg of REQUIRED_PACKAGES) {
    const result = await exec(
      `dpkg -s ${pkg} 2>/dev/null | grep -q "Status: install ok"`,
      {
        throws: false,
      },
    );
    if (!result.success) {
      missing.push(pkg);
    }
  }

  return missing;
}
