import * as p from "@clack/prompts";
import { frakConfig, REGISTRY } from "../lib/context";
import { commandExists, exec } from "../lib/shell";

const SYSTEMD_SERVICE_PATH = `/etc/systemd/system/${REGISTRY.SERVICE_NAME}.service`;

export async function setupRegistry(_args: string[] = []) {
  p.log.step("Registry Cache: Verdaccio npm proxy");

  const serviceExists = await exec(
    `systemctl is-active ${REGISTRY.SERVICE_NAME}`,
    { throws: false },
  );

  if (serviceExists.success) {
    p.log.warn(`Registry cache is already running`);
    await showRegistryStatus();

    const action = await p.select({
      message: "Registry cache already configured. What would you like to do?",
      options: [
        { value: "status", label: "Show status only" },
        {
          value: "recreate",
          label: "Recreate",
          hint: "Stop service, wipe cache, reconfigure",
        },
      ],
    });

    if (p.isCancel(action) || action === "status") {
      return;
    }

    if (action === "recreate") {
      await stopAndClean();
    }
  }

  const spinner = p.spinner();

  spinner.start("Installing Verdaccio");
  await installVerdaccio();
  spinner.stop("Verdaccio installed");

  spinner.start("Writing configuration");
  await writeVerdaccioConfig();
  spinner.stop("Configuration written");

  spinner.start("Setting up filesystem quota");
  await setupFilesystemQuota();
  spinner.stop(`Filesystem quota set (${REGISTRY.QUOTA_SIZE_GB}GB)`);

  spinner.start("Installing cache eviction cron");
  await installEvictionCron();
  spinner.stop(`Eviction cron installed (${REGISTRY.EVICTION_DAYS}-day TTL)`);

  spinner.start("Installing systemd service");
  await installSystemdService();
  spinner.stop("Systemd service installed and started");

  p.log.success("Registry cache setup complete");
  await showRegistryStatus();
}

async function installVerdaccio() {
  const hasVerdaccio = await commandExists("verdaccio");
  if (hasVerdaccio) {
    p.log.info("Verdaccio already installed, skipping");
    return;
  }

  await exec("npm install -g verdaccio");
}

async function writeVerdaccioConfig() {
  await exec(`mkdir -p ${REGISTRY.STORAGE_DIR}`);

  const configYaml = `storage: ${REGISTRY.STORAGE_DIR}

uplinks:
  npmjs:
    url: https://registry.npmjs.org/
    cache: true
    maxage: 30m
    fail_timeout: 5m
    timeout: 30s

packages:
  '@*/*':
    access: $all
    proxy: npmjs

  '**':
    access: $all
    proxy: npmjs

server:
  keepAliveTimeout: 60

middlewares:
  audit:
    enabled: true

log: { type: stdout, format: pretty, level: warn }

max_body_size: 500mb

listen: 0.0.0.0:${REGISTRY.PORT}
`;

  await Bun.write(REGISTRY.CONFIG_PATH, configYaml);
}

async function setupFilesystemQuota() {
  const loopFile = "/var/lib/sandbox/registry/cache.img";
  const loopExists = await exec(`test -f ${loopFile}`, { throws: false });

  if (loopExists.success) {
    p.log.info("Quota loop file already exists, skipping");
    return;
  }

  await exec(`fallocate -l ${REGISTRY.QUOTA_SIZE_GB}G ${loopFile}`);
  await exec(`mkfs.ext4 -q ${loopFile}`);
  await exec(`mkdir -p ${REGISTRY.STORAGE_DIR}`);
  await exec(`mount -o loop ${loopFile} ${REGISTRY.STORAGE_DIR}`);

  const fstabLine = `${loopFile} ${REGISTRY.STORAGE_DIR} ext4 loop,defaults 0 0`;
  const alreadyInFstab = await exec(`grep -qF "${loopFile}" /etc/fstab`, {
    throws: false,
  });
  if (!alreadyInFstab.success) {
    await exec(`echo '${fstabLine}' >> /etc/fstab`);
  }
}

async function installEvictionCron() {
  const evictionScript = `#!/bin/bash
# Evict cached packages not accessed in ${REGISTRY.EVICTION_DAYS} days
STORAGE="${REGISTRY.STORAGE_DIR}"
MAX_AGE=${REGISTRY.EVICTION_DAYS}

if [ ! -d "$STORAGE" ]; then
  exit 0
fi

# Find and delete tarballs not accessed recently
find "$STORAGE" -name "*.tgz" -atime +$MAX_AGE -delete 2>/dev/null

# Clean empty directories left behind
find "$STORAGE" -type d -empty -delete 2>/dev/null

# Log cache size
USED=$(du -sh "$STORAGE" 2>/dev/null | cut -f1)
echo "$(date -Iseconds) registry cache: $USED used (evicted files older than $MAX_AGE days)"
`;

  await Bun.write(REGISTRY.EVICTION_SCRIPT, evictionScript);
  await exec(`chmod +x ${REGISTRY.EVICTION_SCRIPT}`);

  const cronLine = `0 3 * * * ${REGISTRY.EVICTION_SCRIPT} >> /var/log/sandbox/registry-eviction.log 2>&1`;
  const cronExists = await exec(
    `crontab -l 2>/dev/null | grep -qF "${REGISTRY.EVICTION_SCRIPT}"`,
    { throws: false },
  );
  if (!cronExists.success) {
    await exec(`(crontab -l 2>/dev/null; echo '${cronLine}') | crontab -`);
  }
}

async function installSystemdService() {
  const verdaccioPath = (await exec("which verdaccio")).stdout;

  const serviceContent = `[Unit]
Description=Frak Registry Cache (Verdaccio)
After=network.target sandbox-network.service
Wants=sandbox-network.service

[Service]
Type=simple
ExecStart=${verdaccioPath} --config ${REGISTRY.CONFIG_PATH}
Restart=always
RestartSec=5
Environment=VERDACCIO_APPDIR=/var/lib/sandbox/registry
WorkingDirectory=/var/lib/sandbox/registry

[Install]
WantedBy=multi-user.target
`;

  await Bun.write(SYSTEMD_SERVICE_PATH, serviceContent);
  await exec("systemctl daemon-reload");
  await exec(`systemctl enable ${REGISTRY.SERVICE_NAME}`);
  await exec(`systemctl start ${REGISTRY.SERVICE_NAME}`);
}

async function stopAndClean() {
  const spinner = p.spinner();
  spinner.start("Stopping and cleaning registry");

  await exec(`systemctl stop ${REGISTRY.SERVICE_NAME}`, { throws: false });
  await exec(`systemctl disable ${REGISTRY.SERVICE_NAME}`, { throws: false });
  await exec(`rm -f ${SYSTEMD_SERVICE_PATH}`, { throws: false });

  await exec(`umount ${REGISTRY.STORAGE_DIR}`, { throws: false });
  await exec(`rm -f /var/lib/sandbox/registry/cache.img`, { throws: false });
  await exec(`rm -rf ${REGISTRY.STORAGE_DIR}`, { throws: false });
  await exec(
    `crontab -l 2>/dev/null | grep -vF "${REGISTRY.EVICTION_SCRIPT}" | crontab -`,
    { throws: false },
  );

  await exec("systemctl daemon-reload");
  spinner.stop("Registry cleaned");
}

async function showRegistryStatus() {
  const serviceStatus = await exec(
    `systemctl is-active ${REGISTRY.SERVICE_NAME}`,
    { throws: false },
  );

  const cacheSize = await exec(
    `du -sh ${REGISTRY.STORAGE_DIR} 2>/dev/null | cut -f1`,
    { throws: false },
  );

  const quotaUsed = await exec(
    `df -h ${REGISTRY.STORAGE_DIR} 2>/dev/null | tail -1 | awk '{print $3 "/" $2 " (" $5 ")"}'`,
    { throws: false },
  );

  p.note(
    `Service: ${serviceStatus.success ? "running ✓" : "stopped ✗"}
URL: http://${frakConfig.network.bridgeIp}:${REGISTRY.PORT}
Cache size: ${cacheSize.success ? cacheSize.stdout : "N/A"}
Quota: ${quotaUsed.success ? quotaUsed.stdout : "N/A"}
Eviction: packages unused for ${REGISTRY.EVICTION_DAYS}+ days (daily at 3am)
Config: ${REGISTRY.CONFIG_PATH}`,
    "Registry Cache",
  );
}
