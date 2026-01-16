#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";

const ROOT = resolve(import.meta.dirname, "..");
const CLI_DIR = resolve(ROOT, "infra/cli");
const MANAGER_DIR = resolve(ROOT, "apps/manager");
const DASHBOARD_DIR = resolve(ROOT, "apps/dashboard");
const AGENT_DIR = resolve(ROOT, "packages/sandbox-agent");
const INFRA_DIR = resolve(ROOT, "infra");
const IMAGES_DIR = resolve(ROOT, "infra/images");

const REMOTE_APP_DIR = "/opt/frak-sandbox";
const REMOTE_IMAGES_DIR = `${REMOTE_APP_DIR}/infra/images`;
const REMOTE_DASHBOARD_DIR = `${REMOTE_APP_DIR}/apps/dashboard`;

const { SSH_KEY_PATH, SSH_USER, SSH_HOST, SSH_KEY_PASSPHRASE } = process.env;

async function main() {
  if (!SSH_KEY_PATH || !SSH_USER || !SSH_HOST) {
    console.error("Missing env: SSH_KEY_PATH, SSH_USER, SSH_HOST");
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
  const ssh = (cmd: string) => $`ssh -i ${SSH_KEY_PATH} ${target} ${cmd}`;
  const scp = (src: string, dest: string) =>
    $`scp -i ${SSH_KEY_PATH} ${src} ${target}:${dest}`;
  const scpDir = (src: string, dest: string) =>
    $`scp -i ${SSH_KEY_PATH} -r ${src} ${target}:${dest}`;

  console.log("\n📦 Building...");
  await $`bun run --filter @frak-sandbox/cli build:linux`;
  await $`bun run --filter @frak-sandbox/manager build`;
  await $`bun run --filter @frak-sandbox/agent build`;
  await $`bun run --filter @frak-sandbox/dashboard build`;

  console.log("\n🚀 Deploying...");
  await ssh(
    `mkdir -p ${REMOTE_APP_DIR} ${REMOTE_IMAGES_DIR} ${REMOTE_DASHBOARD_DIR}`,
  );

  await scp(
    resolve(CLI_DIR, "dist/frak-sandbox-linux-x64"),
    "/usr/local/bin/frak-sandbox",
  );
  await ssh("chmod +x /usr/local/bin/frak-sandbox");
  console.log("   ✓ CLI");

  await scp(
    resolve(MANAGER_DIR, "dist/server.js"),
    `${REMOTE_APP_DIR}/server.js`,
  );
  await ssh(`rm -rf ${REMOTE_APP_DIR}/drizzle`);
  await scpDir(resolve(MANAGER_DIR, "drizzle"), `${REMOTE_APP_DIR}/`);
  console.log("   ✓ Manager API + Migrations");

  await scp(
    resolve(AGENT_DIR, "dist/sandbox-agent.mjs"),
    `${REMOTE_IMAGES_DIR}/sandbox-agent.mjs`,
  );
  console.log("   ✓ Sandbox Agent");

  await ssh(`rm -rf ${REMOTE_DASHBOARD_DIR}/dist`);
  await scpDir(resolve(DASHBOARD_DIR, "dist"), `${REMOTE_DASHBOARD_DIR}/`);
  console.log("   ✓ Dashboard");

  await scp(
    `${IMAGES_DIR}/build-image.sh`,
    `${REMOTE_IMAGES_DIR}/build-image.sh`,
  );
  await ssh(`chmod +x ${REMOTE_IMAGES_DIR}/build-image.sh`);
  await scpDir(`${IMAGES_DIR}/dev-base`, REMOTE_IMAGES_DIR);
  console.log("   ✓ Base Images");

  await scp(
    `${INFRA_DIR}/systemd/frak-sandbox-manager.service`,
    "/etc/systemd/system/",
  );
  await scp(
    `${INFRA_DIR}/systemd/frak-sandbox-network.service`,
    "/etc/systemd/system/",
  );
  await ssh(
    "systemctl daemon-reload && systemctl enable frak-sandbox-network frak-sandbox-manager",
  );
  console.log("   ✓ Systemd");

  await scp(`${INFRA_DIR}/caddy/Caddyfile`, "/etc/caddy/Caddyfile");
  await ssh("systemctl reload caddy || systemctl start caddy || true");
  console.log("   ✓ Caddy");

  console.log("\n🔄 Restarting manager...");
  await ssh("systemctl restart frak-sandbox-manager");

  await Bun.sleep(2000);
  try {
    await ssh("curl -sf http://localhost:4000/health/live");
    console.log("   ✓ Healthy");
  } catch {
    console.log("   ⚠ Health check failed");
  }

  console.log("\n📋 Post-deploy:");
  console.log("   Build base image: frak-sandbox images build dev-base");

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
