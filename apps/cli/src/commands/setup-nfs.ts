import * as p from "@clack/prompts";
import { frakConfig, NFS } from "../lib/context";
import { exec, fileExists } from "../lib/shell";

export async function setupNfs(_args: string[] = []) {
  p.log.step("Setting up NFS Server for Shared Storage");

  const spinner = p.spinner();

  spinner.start("Installing NFS server packages");
  await exec("apt-get update && apt-get install -y nfs-kernel-server", {
    throws: true,
  });
  spinner.stop("NFS packages installed");

  spinner.start("Creating shared cache directories");
  await exec(`mkdir -p ${NFS.CACHE_EXPORT_DIR}`);
  for (const subdir of Object.values(NFS.CACHE_DIRS)) {
    await exec(`mkdir -p ${NFS.CACHE_EXPORT_DIR}/${subdir}`);
  }
  await exec(`chown -R 1000:1000 ${NFS.CACHE_EXPORT_DIR}`);
  await exec(`chmod -R 777 ${NFS.CACHE_EXPORT_DIR}`);
  spinner.stop("Cache directories created (owned by UID 1000)");

  spinner.start("Creating shared binaries directory");
  await exec(`mkdir -p ${NFS.BINARIES_EXPORT_DIR}/bin`);
  await exec(`chmod -R 755 ${NFS.BINARIES_EXPORT_DIR}`);
  spinner.stop("Binaries directory created");

  spinner.start("Creating shared configs directory");
  await exec(`mkdir -p ${NFS.CONFIGS_EXPORT_DIR}/${NFS.CONFIG_DIRS.GLOBAL}`);
  await exec(
    `mkdir -p ${NFS.CONFIGS_EXPORT_DIR}/${NFS.CONFIG_DIRS.WORKSPACES}`,
  );
  await exec(`chown -R 1000:1000 ${NFS.CONFIGS_EXPORT_DIR}`);
  await exec(`chmod -R 755 ${NFS.CONFIGS_EXPORT_DIR}`);
  spinner.stop("Configs directory created");

  spinner.start("Creating shared auth directory");
  await exec(`mkdir -p ${NFS.AUTH_EXPORT_DIR}`);
  await exec(`chown -R 1000:1000 ${NFS.AUTH_EXPORT_DIR}`);
  await exec(`chmod -R 770 ${NFS.AUTH_EXPORT_DIR}`);
  spinner.stop("Auth directory created (read-write)");

  spinner.start("Configuring NFS exports");
  const cacheExportLine = `${NFS.CACHE_EXPORT_DIR} ${frakConfig.network.bridgeCidr}(rw,sync,no_subtree_check,all_squash,anonuid=1000,anongid=1000,insecure)`;
  const binariesExportLine = `${NFS.BINARIES_EXPORT_DIR} ${frakConfig.network.bridgeCidr}(ro,sync,no_subtree_check,no_root_squash,insecure)`;
  const configsExportLine = `${NFS.CONFIGS_EXPORT_DIR} ${frakConfig.network.bridgeCidr}(ro,sync,no_subtree_check,no_root_squash,insecure)`;
  const authExportLine = `${NFS.AUTH_EXPORT_DIR} ${frakConfig.network.bridgeCidr}(rw,sync,no_subtree_check,all_squash,anonuid=1000,anongid=1000,insecure)`;

  const exportsFile = "/etc/exports";
  let currentExports = (await fileExists(exportsFile))
    ? await Bun.file(exportsFile).text()
    : "";

  let modified = false;
  if (!currentExports.includes(NFS.CACHE_EXPORT_DIR)) {
    currentExports = `${currentExports}\n${cacheExportLine}`;
    p.log.info(`Added cache export: ${cacheExportLine}`);
    modified = true;
  }
  if (!currentExports.includes(NFS.BINARIES_EXPORT_DIR)) {
    currentExports = `${currentExports}\n${binariesExportLine}`;
    p.log.info(`Added binaries export (read-only): ${binariesExportLine}`);
    modified = true;
  }
  if (!currentExports.includes(NFS.CONFIGS_EXPORT_DIR)) {
    currentExports = `${currentExports}\n${configsExportLine}`;
    p.log.info(`Added configs export (read-only): ${configsExportLine}`);
    modified = true;
  }
  if (!currentExports.includes(NFS.AUTH_EXPORT_DIR)) {
    currentExports = `${currentExports}\n${authExportLine}`;
    p.log.info(`Added auth export (read-write): ${authExportLine}`);
    modified = true;
  }
  if (modified) {
    await Bun.write(exportsFile, `${currentExports.trim()}\n`);
  } else {
    p.log.info("Exports already configured");
  }
  spinner.stop("NFS exports configured");

  spinner.start("Configuring firewall for NFS");
  await exec(
    `ufw allow in on ${frakConfig.network.bridgeName} comment 'Allow VM traffic on bridge'`,
    {
      throws: false,
    },
  );
  await exec(
    `ufw allow from ${frakConfig.network.bridgeCidr} to any port 111 proto tcp comment 'NFS portmapper'`,
    { throws: false },
  );
  await exec(
    `ufw allow from ${frakConfig.network.bridgeCidr} to any port 111 proto udp comment 'NFS portmapper UDP'`,
    { throws: false },
  );
  await exec(
    `ufw allow from ${frakConfig.network.bridgeCidr} to any port 2049 proto tcp comment 'NFS'`,
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
    `Cache Export (rw): ${NFS.CACHE_EXPORT_DIR}
Binaries Export (ro): ${NFS.BINARIES_EXPORT_DIR}
Configs Export (ro): ${NFS.CONFIGS_EXPORT_DIR}
Auth Export (rw): ${NFS.AUTH_EXPORT_DIR}
Accessible from: ${frakConfig.network.bridgeCidr}

Guest mounts:
  mount -t nfs ${frakConfig.network.bridgeIp}:${NFS.CACHE_EXPORT_DIR} ${NFS.CACHE_GUEST_MOUNT}
  mount -t nfs -o ro ${frakConfig.network.bridgeIp}:${NFS.BINARIES_EXPORT_DIR} ${NFS.BINARIES_GUEST_MOUNT}
  mount -t nfs -o ro ${frakConfig.network.bridgeIp}:${NFS.CONFIGS_EXPORT_DIR} ${NFS.CONFIGS_GUEST_MOUNT}
  mount -t nfs ${frakConfig.network.bridgeIp}:${NFS.AUTH_EXPORT_DIR} ${NFS.AUTH_GUEST_MOUNT}

Cache directories:
  - ${NFS.CACHE_EXPORT_DIR}/${NFS.CACHE_DIRS.BUN} (Bun cache)
  - ${NFS.CACHE_EXPORT_DIR}/${NFS.CACHE_DIRS.NPM} (npm cache)
  - ${NFS.CACHE_EXPORT_DIR}/${NFS.CACHE_DIRS.PNPM} (pnpm cache)
  - ${NFS.CACHE_EXPORT_DIR}/${NFS.CACHE_DIRS.PIP} (pip cache)

Binaries directory:
  - ${NFS.BINARIES_EXPORT_DIR}/bin (add to PATH)

Configs directories:
  - ${NFS.CONFIGS_EXPORT_DIR}/${NFS.CONFIG_DIRS.GLOBAL} (global configs)
  - ${NFS.CONFIGS_EXPORT_DIR}/${NFS.CONFIG_DIRS.WORKSPACES}/<id> (workspace configs)

Auth directory:
  - ${NFS.AUTH_EXPORT_DIR}/<provider>.json (shared auth files, rw)
  
Install binaries via Manager API: POST /api/storage/binaries/:name/install
Configs synced automatically by Manager on update`,
    "NFS Configuration",
  );
}
