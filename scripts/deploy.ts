#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";

const ROOT = resolve(import.meta.dirname, "..");
const CLI_DIR = resolve(ROOT, "apps/cli");
const MANAGER_DIR = resolve(ROOT, "apps/manager");
const DASHBOARD_DIR = resolve(ROOT, "apps/dashboard");
const AGENT_DIR = resolve(ROOT, "apps/agent");
const INFRA_DIR = resolve(ROOT, "infra");
const IMAGES_DIR = resolve(ROOT, "infra/images");

const STAGING_DIR = resolve(ROOT, ".deploy-staging");
const TARBALL_NAME = "frak-sandbox-deploy.tar.gz";

const {
  SSH_KEY_PATH,
  SSH_USER,
  SSH_HOST,
  SSH_KEY_PASSPHRASE,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_CALLBACK_URL,
  GITHUB_LOGIN_CALLBACK_URL,
  DASHBOARD_URL,
  JWT_SECRET,
  AUTH_ALLOWED_ORG,
  AUTH_ALLOWED_USERS,
} = process.env;

const REBUILD_IMAGE = process.argv.includes("--rebuild-image");

async function main() {
  if (!SSH_KEY_PATH || !SSH_USER || !SSH_HOST) {
    console.error("Missing env: SSH_KEY_PATH, SSH_USER, SSH_HOST");
    console.error("Set in .env or export them");
    process.exit(1);
  }

  if (
    !GITHUB_CLIENT_ID ||
    !GITHUB_CLIENT_SECRET ||
    !GITHUB_CALLBACK_URL ||
    !GITHUB_LOGIN_CALLBACK_URL ||
    !DASHBOARD_URL ||
    !JWT_SECRET
  ) {
    console.error(
      "Missing required env vars: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_CALLBACK_URL, GITHUB_LOGIN_CALLBACK_URL, DASHBOARD_URL, JWT_SECRET",
    );
    console.error("Set in .env or export them");
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
  await $`bun run --filter @frak-sandbox/cli build:linux`;
  await $`bun run --filter @frak-sandbox/manager build`;
  await $`bun run --filter @frak-sandbox/agent build`;
  await $`bun run --filter @frak-sandbox/dashboard build`;

  console.log("\n📁 Staging files...");
  rmSync(STAGING_DIR, { recursive: true, force: true });
  mkdirSync(STAGING_DIR, { recursive: true });

  const dirs = [
    "opt/frak-sandbox/drizzle",
    "opt/frak-sandbox/infra/images/dev-base",
    "opt/frak-sandbox/infra/images/dev-cloud",
    "opt/frak-sandbox/apps/dashboard",
    "usr/local/bin",
    "etc/systemd/system",
    "etc/caddy",
  ];
  for (const dir of dirs) {
    mkdirSync(resolve(STAGING_DIR, dir), { recursive: true });
  }

  cpSync(
    resolve(CLI_DIR, "dist/frak-sandbox-linux-x64"),
    resolve(STAGING_DIR, "usr/local/bin/frak-sandbox"),
  );
  cpSync(
    resolve(MANAGER_DIR, "dist/server.js"),
    resolve(STAGING_DIR, "opt/frak-sandbox/server.js"),
  );
  cpSync(
    resolve(MANAGER_DIR, "drizzle"),
    resolve(STAGING_DIR, "opt/frak-sandbox/drizzle"),
    { recursive: true },
  );
  cpSync(
    resolve(AGENT_DIR, "dist/sandbox-agent.mjs"),
    resolve(STAGING_DIR, "opt/frak-sandbox/infra/images/sandbox-agent.mjs"),
  );
  cpSync(
    resolve(DASHBOARD_DIR, "dist"),
    resolve(STAGING_DIR, "opt/frak-sandbox/apps/dashboard/dist"),
    { recursive: true },
  );
  cpSync(
    resolve(IMAGES_DIR, "build-image.sh"),
    resolve(STAGING_DIR, "opt/frak-sandbox/infra/images/build-image.sh"),
  );
  cpSync(
    resolve(IMAGES_DIR, "dev-base"),
    resolve(STAGING_DIR, "opt/frak-sandbox/infra/images/dev-base"),
    { recursive: true },
  );
  cpSync(
    resolve(IMAGES_DIR, "dev-cloud"),
    resolve(STAGING_DIR, "opt/frak-sandbox/infra/images/dev-cloud"),
    { recursive: true },
  );

  const managerServiceTemplate = await Bun.file(
    resolve(INFRA_DIR, "systemd/frak-sandbox-manager.service"),
  ).text();
  const managerService = managerServiceTemplate
    .replace("{{GITHUB_CLIENT_ID}}", GITHUB_CLIENT_ID || "")
    .replace("{{GITHUB_CLIENT_SECRET}}", GITHUB_CLIENT_SECRET || "")
    .replace("{{GITHUB_CALLBACK_URL}}", GITHUB_CALLBACK_URL || "")
    .replace("{{GITHUB_LOGIN_CALLBACK_URL}}", GITHUB_LOGIN_CALLBACK_URL || "")
    .replace("{{DASHBOARD_URL}}", DASHBOARD_URL || "")
    .replace("{{JWT_SECRET}}", JWT_SECRET || "")
    .replace("{{AUTH_ALLOWED_ORG}}", AUTH_ALLOWED_ORG || "frak-id")
    .replace(
      "{{AUTH_ALLOWED_USERS}}",
      AUTH_ALLOWED_USERS || "srod,konfeature,mviala",
    );
  await Bun.write(
    resolve(STAGING_DIR, "etc/systemd/system/frak-sandbox-manager.service"),
    managerService,
  );
  cpSync(
    resolve(INFRA_DIR, "systemd/frak-sandbox-network.service"),
    resolve(STAGING_DIR, "etc/systemd/system/frak-sandbox-network.service"),
  );
  cpSync(
    resolve(INFRA_DIR, "caddy/Caddyfile"),
    resolve(STAGING_DIR, "etc/caddy/Caddyfile"),
  );
  console.log("   ✓ Staged all artifacts");

  console.log("\n📦 Creating tarball...");
  const tarballPath = resolve(ROOT, TARBALL_NAME);
  // COPYFILE_DISABLE=1 prevents macOS from including AppleDouble (._*) files
  await $`tar -czf ${tarballPath} -C ${STAGING_DIR} .`.env({
    ...process.env,
    COPYFILE_DISABLE: "1",
  });
  const tarballSize = (await Bun.file(tarballPath).size) / 1024 / 1024;
  console.log(`   ✓ Created ${TARBALL_NAME} (${tarballSize.toFixed(2)} MB)`);

  console.log("\n🚀 Uploading...");
  await $`scp -i ${SSH_KEY_PATH} ${tarballPath} ${target}:/tmp/${TARBALL_NAME}`;
  console.log("   ✓ Uploaded tarball");

  console.log("\n⚙️  Installing on server...");

  const installScript = `
set -e

DEPLOY_TMP="/tmp/frak-deploy-$$"
mkdir -p "$DEPLOY_TMP"
tar -xzf /tmp/${TARBALL_NAME} -C "$DEPLOY_TMP"

mkdir -p /opt/frak-sandbox/infra/images /opt/frak-sandbox/apps/dashboard /opt/frak-sandbox/drizzle

# Stop service and kill any CLI processes before overwriting binary (Text file busy fix)
systemctl stop frak-sandbox-manager || true
pkill -9 frak-sandbox || true
sleep 1

cp "$DEPLOY_TMP/usr/local/bin/frak-sandbox" /usr/local/bin/frak-sandbox
cp "$DEPLOY_TMP/opt/frak-sandbox/server.js" /opt/frak-sandbox/server.js
cp -r "$DEPLOY_TMP/opt/frak-sandbox/drizzle/." /opt/frak-sandbox/drizzle/
cp "$DEPLOY_TMP/opt/frak-sandbox/infra/images/sandbox-agent.mjs" /opt/frak-sandbox/infra/images/sandbox-agent.mjs
cp "$DEPLOY_TMP/opt/frak-sandbox/infra/images/build-image.sh" /opt/frak-sandbox/infra/images/build-image.sh
cp -r "$DEPLOY_TMP/opt/frak-sandbox/infra/images/dev-base/." /opt/frak-sandbox/infra/images/dev-base/
cp -r "$DEPLOY_TMP/opt/frak-sandbox/infra/images/dev-cloud/." /opt/frak-sandbox/infra/images/dev-cloud/
cp -r "$DEPLOY_TMP/opt/frak-sandbox/apps/dashboard/dist/." /opt/frak-sandbox/apps/dashboard/dist/
cp "$DEPLOY_TMP/etc/systemd/system/frak-sandbox-manager.service" /etc/systemd/system/frak-sandbox-manager.service
cp "$DEPLOY_TMP/etc/systemd/system/frak-sandbox-network.service" /etc/systemd/system/frak-sandbox-network.service
cp "$DEPLOY_TMP/etc/caddy/Caddyfile" /etc/caddy/Caddyfile

chmod +x /usr/local/bin/frak-sandbox
chmod +x /opt/frak-sandbox/infra/images/build-image.sh

systemctl daemon-reload
systemctl enable frak-sandbox-network frak-sandbox-manager
systemctl reload caddy || systemctl start caddy || true
systemctl restart frak-sandbox-manager

rm -rf "$DEPLOY_TMP" /tmp/${TARBALL_NAME}

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
      await $`ssh -i ${SSH_KEY_PATH} ${target} "frak-sandbox images build dev-base"`;
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
