import * as p from "@clack/prompts";
import { FIRECRACKER, PATHS } from "../lib/context";
import { exec, fileExists, getArch, isValidElf } from "../lib/shell";

export async function installFirecracker(_args: string[] = []) {
  p.log.step("Phase 1.2: Install Firecracker");

  const spinner = p.spinner();
  const arch = await getArch();

  const fcPath = "/usr/local/bin/firecracker";
  if (await fileExists(fcPath)) {
    const { stdout } = await exec(`${fcPath} --version 2>/dev/null | head -1`, {
      throws: false,
    });
    const currentVersion = stdout.match(/v?(\d+\.\d+\.\d+)/)?.[1];

    if (currentVersion === FIRECRACKER.VERSION) {
      p.log.success(`Firecracker v${FIRECRACKER.VERSION} already installed`);
    } else {
      p.log.warn(
        `Upgrading Firecracker from v${currentVersion} to v${FIRECRACKER.VERSION}`,
      );
      await downloadFirecracker(spinner, arch);
    }
  } else {
    await downloadFirecracker(spinner, arch);
  }

  await downloadKernel(spinner, arch);
  await downloadRootfs(spinner, arch);
  await verifyInstallation(spinner);

  p.log.success("Firecracker installation complete");
  p.note(
    `Kernel: ${PATHS.KERNEL_DIR}/vmlinux
Rootfs: ${PATHS.ROOTFS_DIR}/rootfs.ext4
SSH Key: ${PATHS.ROOTFS_DIR}/vm-ssh-key`,
    "Installed",
  );
}

async function downloadFirecracker(
  spinner: ReturnType<typeof p.spinner>,
  arch: string,
) {
  spinner.start(`Downloading Firecracker v${FIRECRACKER.VERSION}`);

  const tarball = `firecracker-v${FIRECRACKER.VERSION}-${arch}.tgz`;
  const url = `${FIRECRACKER.RELEASE_URL}/download/v${FIRECRACKER.VERSION}/${tarball}`;
  const releaseDir = `release-v${FIRECRACKER.VERSION}-${arch}`;

  await exec(
    "rm -rf /tmp/firecracker-release && mkdir -p /tmp/firecracker-release",
  );
  await exec(
    `cd /tmp/firecracker-release && wget -q ${url} && tar -xzf ${tarball}`,
  );

  await exec(
    `install -m 0755 /tmp/firecracker-release/${releaseDir}/firecracker-v${FIRECRACKER.VERSION}-${arch} /usr/local/bin/firecracker`,
  );
  await exec(
    `install -m 0755 /tmp/firecracker-release/${releaseDir}/jailer-v${FIRECRACKER.VERSION}-${arch} /usr/local/bin/jailer`,
  );

  await exec("rm -rf /tmp/firecracker-release");
  spinner.stop(`Firecracker v${FIRECRACKER.VERSION} installed`);
}

async function downloadKernel(
  spinner: ReturnType<typeof p.spinner>,
  arch: string,
) {
  spinner.start("Fetching latest CI kernel");

  const latestVersion = await getLatestCIVersion();
  const prefix = `firecracker-ci/${latestVersion}/${arch}/vmlinux-`;
  const listUrl = `http://spec.ccfc.min.s3.amazonaws.com/?prefix=${prefix}&list-type=2`;

  const { stdout: xml } = await exec(`curl -s "${listUrl}"`);
  const keys = xml.match(
    new RegExp(
      `firecracker-ci/${latestVersion}/${arch}/vmlinux-[0-9]+\\.[0-9]+\\.[0-9]{1,3}`,
      "g",
    ),
  );

  if (!keys?.length) {
    throw new Error("Could not find kernel in Firecracker CI S3 bucket");
  }

  const latestKey = keys.sort().pop() ?? "";
  const kernelName = latestKey.split("/").pop() ?? "unknown";
  const kernelPath = `${PATHS.KERNEL_DIR}/${kernelName}`;

  if (await fileExists(kernelPath)) {
    spinner.stop(`Kernel already exists: ${kernelName}`);
  } else {
    spinner.message(`Downloading ${kernelName}`);
    await exec(
      `wget -q -O ${kernelPath} ${FIRECRACKER.S3_BUCKET}/${latestKey}`,
    );

    if (!(await isValidElf(kernelPath))) {
      await exec(`rm -f ${kernelPath}`);
      throw new Error("Downloaded kernel is not a valid ELF binary");
    }
    spinner.stop(`Kernel downloaded: ${kernelName}`);
  }

  await exec(`ln -sf ${kernelPath} ${PATHS.KERNEL_DIR}/vmlinux`);
}

async function downloadRootfs(
  spinner: ReturnType<typeof p.spinner>,
  arch: string,
) {
  spinner.start("Fetching latest CI rootfs");

  const latestVersion = await getLatestCIVersion();
  const prefix = `firecracker-ci/${latestVersion}/${arch}/ubuntu-`;
  const listUrl = `http://spec.ccfc.min.s3.amazonaws.com/?prefix=${prefix}&list-type=2`;

  const { stdout: xml } = await exec(`curl -s "${listUrl}"`);
  const keys = xml.match(
    new RegExp(
      `firecracker-ci/${latestVersion}/${arch}/ubuntu-[0-9]+\\.[0-9]+\\.squashfs`,
      "g",
    ),
  );

  if (!keys?.length) {
    throw new Error("Could not find rootfs in Firecracker CI S3 bucket");
  }

  const latestKey = keys.sort().pop() ?? "";
  const ubuntuVersion = latestKey.match(/ubuntu-(\d+\.\d+)/)?.[1] ?? "unknown";
  const rootfsName = `ubuntu-${ubuntuVersion}.ext4`;
  const rootfsPath = `${PATHS.ROOTFS_DIR}/${rootfsName}`;

  if (await fileExists(rootfsPath)) {
    spinner.stop(`Rootfs already exists: ${rootfsName}`);
  } else {
    const squashfsPath = `/tmp/ubuntu-${ubuntuVersion}.squashfs`;
    const extractDir = `/tmp/squashfs-root-${Date.now()}`;

    spinner.message(`Downloading Ubuntu ${ubuntuVersion} squashfs`);
    await exec(
      `wget -q -O ${squashfsPath} ${FIRECRACKER.S3_BUCKET}/${latestKey}`,
    );

    spinner.message("Extracting and converting to ext4");
    await exec(
      `rm -rf ${extractDir} && unsquashfs -d ${extractDir} ${squashfsPath}`,
    );

    const sshKeyPath = `${PATHS.ROOTFS_DIR}/vm-ssh-key`;
    if (!(await fileExists(sshKeyPath))) {
      await exec(
        `ssh-keygen -t ed25519 -f ${sshKeyPath} -N "" -C "sandbox-vm-key"`,
      );
    }

    await exec(`mkdir -p ${extractDir}/root/.ssh`);
    await exec(`cp ${sshKeyPath}.pub ${extractDir}/root/.ssh/authorized_keys`);
    await exec(`chmod 700 ${extractDir}/root/.ssh`);
    await exec(`chmod 600 ${extractDir}/root/.ssh/authorized_keys`);

    // Also inject for dev user (sshpiper connects as dev)
    await exec(`mkdir -p ${extractDir}/home/dev/.ssh`);
    await exec(
      `cp ${sshKeyPath}.pub ${extractDir}/home/dev/.ssh/authorized_keys`,
    );
    await exec(`chmod 700 ${extractDir}/home/dev/.ssh`);
    await exec(`chmod 600 ${extractDir}/home/dev/.ssh/authorized_keys`);
    await exec(`chown -R 1000:1000 ${extractDir}/home/dev/.ssh`);

    spinner.message("Creating ext4 filesystem (1GB)");
    await exec(`truncate -s 1G ${rootfsPath}`);
    await exec(`mkfs.ext4 -d ${extractDir} -F ${rootfsPath} > /dev/null 2>&1`);

    await exec(`rm -rf ${extractDir} ${squashfsPath}`);
    spinner.stop(`Rootfs created: ${rootfsName}`);
  }

  await exec(`ln -sf ${rootfsPath} ${PATHS.ROOTFS_DIR}/rootfs.ext4`);
}

async function getLatestCIVersion(): Promise<string> {
  const { stdout } = await exec(
    `curl -fsSLI -o /dev/null -w '%{url_effective}' ${FIRECRACKER.RELEASE_URL}/latest`,
  );
  const version = stdout.split("/").pop() ?? "";
  return version.replace(/\.\d+$/, "");
}

async function verifyInstallation(spinner: ReturnType<typeof p.spinner>) {
  spinner.start("Verifying installation");

  const checks = [
    { cmd: "firecracker --version", name: "Firecracker" },
    { cmd: "jailer --version", name: "Jailer" },
    { cmd: `test -L ${PATHS.KERNEL_DIR}/vmlinux`, name: "Kernel symlink" },
    { cmd: `test -L ${PATHS.ROOTFS_DIR}/rootfs.ext4`, name: "Rootfs symlink" },
  ];

  for (const check of checks) {
    const result = await exec(check.cmd, { throws: false });
    if (!result.success) {
      spinner.stop("Verification failed");
      throw new Error(`${check.name} verification failed`);
    }
  }

  spinner.stop("All components verified");
}
