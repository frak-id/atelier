#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
import {
  CONFIG_FILE_NAME,
  loadConfig,
} from "../packages/shared/src/config.loader.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CLI_DIR = resolve(ROOT, "apps/cli");
const MANAGER_DIR = resolve(ROOT, "apps/manager");
const DASHBOARD_DIR = resolve(ROOT, "apps/dashboard");
const AGENT_DIR = resolve(ROOT, "apps/agent-rust");
const INFRA_DIR = resolve(ROOT, "infra");
const IMAGES_DIR = resolve(ROOT, "infra/images");

const STAGING_DIR = resolve(ROOT, ".deploy-staging");
const TARBALL_NAME = "atelier-deploy.tar.gz";
const CONFIG_FILE = resolve(ROOT, CONFIG_FILE_NAME);

const { SSH_KEY_PATH, SSH_USER, SSH_HOST, SSH_KEY_PASSPHRASE } = process.env;

const REBUILD_IMAGE = process.argv.includes("--rebuild-image");

async function main() {
  if (!SSH_KEY_PATH || !SSH_USER || !SSH_HOST) {
    console.error("Missing env: SSH_KEY_PATH, SSH_USER, SSH_HOST");
    console.error("Set in .env or export them");
    process.exit(1);
  }

  if (!existsSync(CONFIG_FILE)) {
    console.error(
      `Config file not found: ${CONFIG_FILE}\nCopy sandbox.config.example.json to sandbox.config.json and fill in your values.`,
    );
    process.exit(1);
  }

  const atelierConfig = loadConfig({ configFile: CONFIG_FILE });

  if (
    !atelierConfig.auth.githubClientId ||
    !atelierConfig.auth.githubClientSecret ||
    !atelierConfig.auth.jwtSecret
  ) {
    console.error(
      "Missing required secrets: githubClientId, githubClientSecret, jwtSecret",
    );
    console.error("Set them in sandbox.config.json (auth section)");
    process.exit(1);
  }

  if (!existsSync(SSH_KEY_PATH)) {
    console.error(`SSH key not found: ${SSH_KEY_PATH}`);
    process.exit(1);
  }

  if (SSH_KEY_PASSPHRASE) {
    console.log("Adding SSH key to agent...");
    await addKeyToAgent(SSH_KEY_PATH, SSH_KEY_PASSPHRASE);
  }

  const target = `${SSH_USER}@${SSH_HOST}`;

  console.log("\n📦 Building...");
  await $`bun run --filter @frak/atelier-cli build:linux`;
  await $`bun run --filter @frak/atelier-manager build`;
  await $`CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=x86_64-linux-musl-gcc cargo build --release --target x86_64-unknown-linux-musl --manifest-path ${resolve(AGENT_DIR, "Cargo.toml")}`;
  mkdirSync(resolve(AGENT_DIR, "dist"), { recursive: true });
  cpSync(
    resolve(
      AGENT_DIR,
      "target/x86_64-unknown-linux-musl/release/sandbox-agent",
    ),
    resolve(AGENT_DIR, "dist/sandbox-agent"),
  );
  await $`bun run --filter @frak/atelier-dashboard build`;

  console.log("\n📁 Staging files...");
  rmSync(STAGING_DIR, { recursive: true, force: true });
  mkdirSync(STAGING_DIR, { recursive: true });

  const dirs = [
    "opt/atelier/drizzle",
    "opt/atelier/infra/images/dev-base",
    "opt/atelier/infra/images/dev-cloud",
    "opt/atelier/apps/dashboard",
    "usr/local/bin",
    "etc/systemd/system",
    "etc/caddy",
    "etc/atelier",
  ];
  for (const dir of dirs) {
    mkdirSync(resolve(STAGING_DIR, dir), { recursive: true });
  }

  cpSync(
    resolve(CLI_DIR, "dist/atelier-linux-x64"),
    resolve(STAGING_DIR, "usr/local/bin/atelier"),
  );
  cpSync(
    resolve(MANAGER_DIR, "dist/server.js"),
    resolve(STAGING_DIR, "opt/atelier/server.js"),
  );
  cpSync(
    resolve(MANAGER_DIR, "drizzle"),
    resolve(STAGING_DIR, "opt/atelier/drizzle"),
    { recursive: true },
  );
  cpSync(
    resolve(AGENT_DIR, "dist/sandbox-agent"),
    resolve(STAGING_DIR, "opt/atelier/infra/images/sandbox-agent"),
  );
  cpSync(
    resolve(DASHBOARD_DIR, "dist"),
    resolve(STAGING_DIR, "opt/atelier/apps/dashboard/dist"),
    { recursive: true },
  );
  cpSync(
    resolve(IMAGES_DIR, "build-image.sh"),
    resolve(STAGING_DIR, "opt/atelier/infra/images/build-image.sh"),
  );
  cpSync(
    resolve(IMAGES_DIR, "dev-base"),
    resolve(STAGING_DIR, "opt/atelier/infra/images/dev-base"),
    { recursive: true },
  );
  cpSync(
    resolve(IMAGES_DIR, "dev-cloud"),
    resolve(STAGING_DIR, "opt/atelier/infra/images/dev-cloud"),
    { recursive: true },
  );

  cpSync(CONFIG_FILE, resolve(STAGING_DIR, `etc/atelier/${CONFIG_FILE_NAME}`));

  cpSync(
    resolve(INFRA_DIR, "systemd/atelier-manager.service"),
    resolve(STAGING_DIR, "etc/systemd/system/atelier-manager.service"),
  );
  cpSync(
    resolve(INFRA_DIR, "systemd/atelier-network.service"),
    resolve(STAGING_DIR, "etc/systemd/system/atelier-network.service"),
  );

  const caddyfileTemplate = await Bun.file(
    resolve(INFRA_DIR, "caddy/Caddyfile.template"),
  ).text();
  const useManualTls =
    atelierConfig.tls.certPath?.trim().length > 0 &&
    atelierConfig.tls.keyPath?.trim().length > 0;
  let caddyfile = caddyfileTemplate
    .replace(/\{\{SSL_EMAIL\}\}/g, atelierConfig.tls.email)
    .replace(/\{\{DASHBOARD_DOMAIN\}\}/g, atelierConfig.domains.dashboard)
    .replace(/\{\{DOMAIN_SUFFIX\}\}/g, atelierConfig.domains.sandboxSuffix)
    .replace(/\{\{MANAGER_PORT\}\}/g, String(atelierConfig.runtime.port));

  if (useManualTls) {
    caddyfile = caddyfile
      .replace(/\{\{#MANUAL_TLS\}\}/g, "")
      .replace(/\{\{\/MANUAL_TLS\}\}/g, "")
      .replace(/\{\{TLS_CERT_PATH\}\}/g, atelierConfig.tls.certPath)
      .replace(/\{\{TLS_KEY_PATH\}\}/g, atelierConfig.tls.keyPath)
      .replace(/\{\{TLS_CONFIG\}\}/g, "import tls_manual");
  } else {
    caddyfile = caddyfile
      .replace(/\{\{#MANUAL_TLS\}\}[\s\S]*?\{\{\/MANUAL_TLS\}\}\n?/g, "")
      .replace(/\{\{TLS_CONFIG\}\}/g, "")
      .replace(/\{\{TLS_CERT_PATH\}\}|\{\{TLS_KEY_PATH\}\}/g, "");
  }
  await Bun.write(resolve(STAGING_DIR, "etc/caddy/Caddyfile"), caddyfile);
  console.log("   ✓ Staged all artifacts");

  console.log("\n📦 Creating tarball...");
  const tarballPath = resolve(ROOT, TARBALL_NAME);
  await $`tar --no-xattrs --no-mac-metadata -czf ${tarballPath} -C ${STAGING_DIR} .`.env(
    {
      ...process.env,
      COPYFILE_DISABLE: "1",
    },
  );
  const tarballSize = (await Bun.file(tarballPath).size) / 1024 / 1024;
  console.log(`   ✓ Created ${TARBALL_NAME} (${tarballSize.toFixed(2)} MB)`);

  console.log("\n🚀 Uploading...");
  await $`scp -i ${SSH_KEY_PATH} ${tarballPath} ${target}:/tmp/${TARBALL_NAME}`;
  console.log("   ✓ Uploaded tarball");

  console.log("\n⚙️  Installing on server...");

  const installScript = `
set -e

DEPLOY_TMP="/tmp/atelier-deploy-$$"
mkdir -p "$DEPLOY_TMP"
tar -xzf /tmp/${TARBALL_NAME} -C "$DEPLOY_TMP"

mkdir -p /opt/atelier/infra/images /opt/atelier/apps/dashboard /opt/atelier/drizzle /etc/atelier

# Stop service and kill any CLI processes before overwriting binary (Text file busy fix)
systemctl stop atelier-manager || true
pkill -9 atelier || true
sleep 1

cp "$DEPLOY_TMP/usr/local/bin/atelier" /usr/local/bin/atelier
cp "$DEPLOY_TMP/opt/atelier/server.js" /opt/atelier/server.js
cp -r "$DEPLOY_TMP/opt/atelier/drizzle/." /opt/atelier/drizzle/
cp "$DEPLOY_TMP/opt/atelier/infra/images/sandbox-agent" /opt/atelier/infra/images/sandbox-agent
cp "$DEPLOY_TMP/opt/atelier/infra/images/build-image.sh" /opt/atelier/infra/images/build-image.sh
cp -r "$DEPLOY_TMP/opt/atelier/infra/images/dev-base/." /opt/atelier/infra/images/dev-base/
cp -r "$DEPLOY_TMP/opt/atelier/infra/images/dev-cloud/." /opt/atelier/infra/images/dev-cloud/
cp -r "$DEPLOY_TMP/opt/atelier/apps/dashboard/dist/." /opt/atelier/apps/dashboard/dist/
cp "$DEPLOY_TMP/etc/atelier/${CONFIG_FILE_NAME}" /etc/atelier/${CONFIG_FILE_NAME}
cp "$DEPLOY_TMP/etc/systemd/system/atelier-manager.service" /etc/systemd/system/atelier-manager.service
cp "$DEPLOY_TMP/etc/systemd/system/atelier-network.service" /etc/systemd/system/atelier-network.service
cp "$DEPLOY_TMP/etc/caddy/Caddyfile" /etc/caddy/Caddyfile

chmod +x /usr/local/bin/atelier
chmod +x /opt/atelier/infra/images/build-image.sh

systemctl daemon-reload
systemctl enable atelier-network atelier-manager
systemctl reload caddy || systemctl start caddy || true
systemctl restart atelier-manager

sleep 2
curl -sf http://localhost:4000/health/live > /dev/null && echo "HEALTH_OK" || echo "HEALTH_FAIL"
`;

  const result =
    await $`ssh -i ${SSH_KEY_PATH} ${target} ${installScript}`.text();

  if (result.includes("HEALTH_OK")) {
    console.log("   ✓ Installed and healthy");
  } else {
    console.log("   ⚠ Installed but health check failed");
  }

  rmSync(STAGING_DIR, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });

  if (REBUILD_IMAGE) {
    console.log("\n🐳 Rebuilding base image (this takes a few minutes)...");
    try {
      await $`ssh -i ${SSH_KEY_PATH} ${target} "atelier images build dev-base"`;
      console.log("   ✓ Base image rebuilt");
    } catch (err) {
      console.error("   ✗ Image rebuild failed:", err);
      process.exit(1);
    }
  } else {
    console.log("\n📋 Post-deploy:");
    console.log("   Build base image: bun run deploy -- --rebuild-image");
  }

  console.log("\n✅ Done!");
}

async function addKeyToAgent(keyPath: string, passphrase: string) {
  const askpass = `/tmp/ssh-askpass-${process.pid}`;
  await Bun.write(
    askpass,
    `#!/bin/sh\necho '${passphrase.replace(/'/g, "'\\''")}'`,
  );
  await $`chmod +x ${askpass}`;

  try {
    await $`ssh-add ${keyPath}`.env({
      ...process.env,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: ":0",
    });
  } finally {
    await $`rm -f ${askpass}`.quiet();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
