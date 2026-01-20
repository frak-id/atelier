import * as p from "@clack/prompts";
import { NETWORK, NFS } from "../lib/context";
import { exec, fileExists } from "../lib/shell";

export async function setupNfs(_args: string[] = []) {
  p.log.step("Setting up NFS Server for Shared Cache");

  const spinner = p.spinner();

  spinner.start("Installing NFS server packages");
  await exec("apt-get update && apt-get install -y nfs-kernel-server", {
    throws: true,
  });
  spinner.stop("NFS packages installed");

  spinner.start("Creating shared cache directories");
  await exec(`mkdir -p ${NFS.EXPORT_DIR}`);
  for (const subdir of Object.values(NFS.CACHE_DIRS)) {
    await exec(`mkdir -p ${NFS.EXPORT_DIR}/${subdir}`);
  }
  await exec(`chmod -R 777 ${NFS.EXPORT_DIR}`);
  spinner.stop("Cache directories created");

  spinner.start("Configuring NFS exports");
  const exportLine = `${NFS.EXPORT_DIR} ${NETWORK.BRIDGE_CIDR}(rw,sync,no_subtree_check,no_root_squash,insecure)`;

  const exportsFile = "/etc/exports";
  const currentExports = (await fileExists(exportsFile))
    ? await Bun.file(exportsFile).text()
    : "";

  if (!currentExports.includes(NFS.EXPORT_DIR)) {
    await Bun.write(exportsFile, `${currentExports}\n${exportLine}\n`);
    p.log.info(`Added export: ${exportLine}`);
  } else {
    p.log.info("Export already configured");
  }
  spinner.stop("NFS exports configured");

  spinner.start("Configuring firewall for NFS");
  await exec("ufw allow in on br0 comment 'Allow VM traffic on bridge'", {
    throws: false,
  });
  await exec(
    `ufw allow from ${NETWORK.BRIDGE_CIDR} to any port 111 proto tcp comment 'NFS portmapper'`,
    { throws: false },
  );
  await exec(
    `ufw allow from ${NETWORK.BRIDGE_CIDR} to any port 111 proto udp comment 'NFS portmapper UDP'`,
    { throws: false },
  );
  await exec(
    `ufw allow from ${NETWORK.BRIDGE_CIDR} to any port 2049 proto tcp comment 'NFS'`,
    { throws: false },
  );
  spinner.stop("Firewall configured for NFS");

  spinner.start("Starting NFS server");
  await exec("exportfs -ra");
  await exec("systemctl enable nfs-kernel-server");
  await exec("systemctl restart nfs-kernel-server");
  spinner.stop("NFS server started");

  spinner.start("Verifying NFS exports");
  const { stdout: exports } = await exec("exportfs -v");
  spinner.stop("NFS exports verified");
  console.log(exports);

  p.log.success("NFS server setup complete");

  p.note(
    `NFS Export: ${NFS.EXPORT_DIR}
Accessible from: ${NETWORK.BRIDGE_CIDR}
Guest mount: mount -t nfs ${NFS.HOST_IP}:${NFS.EXPORT_DIR} ${NFS.GUEST_MOUNT}

Cache directories:
  - ${NFS.EXPORT_DIR}/${NFS.CACHE_DIRS.BUN} (Bun cache)
  - ${NFS.EXPORT_DIR}/${NFS.CACHE_DIRS.NPM} (npm cache)
  - ${NFS.EXPORT_DIR}/${NFS.CACHE_DIRS.PNPM} (pnpm cache)
  - ${NFS.EXPORT_DIR}/${NFS.CACHE_DIRS.PIP} (pip cache)`,
    "NFS Configuration",
  );
}
