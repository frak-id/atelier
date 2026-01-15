#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");
const CLI_DIR = resolve(ROOT, "infra/cli");
const MANAGER_DIR = resolve(ROOT, "apps/manager");
const INFRA_DIR = resolve(ROOT, "infra");

const REMOTE_APP_DIR = "/opt/frak-sandbox";

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
  const scp = (src: string, dest: string) => $`scp -i ${SSH_KEY_PATH} ${src} ${target}:${dest}`;

  console.log("\n📦 Building...");
  await $`bun run --filter @frak-sandbox/cli build:linux`;
  await $`bun run --filter @frak-sandbox/manager build`;

  console.log("\n🚀 Deploying...");
  await ssh(`mkdir -p ${REMOTE_APP_DIR}`);

  await scp(resolve(CLI_DIR, "dist/frak-sandbox-linux-x64"), "/usr/local/bin/frak-sandbox");
  await ssh("chmod +x /usr/local/bin/frak-sandbox");
  console.log("   ✓ CLI");

  await scp(resolve(MANAGER_DIR, "dist/server.js"), `${REMOTE_APP_DIR}/server.js`);
  console.log("   ✓ API");

  await scp(`${INFRA_DIR}/systemd/frak-sandbox-manager.service`, "/etc/systemd/system/");
  await scp(`${INFRA_DIR}/systemd/frak-sandbox-network.service`, "/etc/systemd/system/");
  await ssh("systemctl daemon-reload && systemctl enable frak-sandbox-network frak-sandbox-manager");
  console.log("   ✓ Systemd");

  await scp(`${INFRA_DIR}/caddy/Caddyfile`, "/etc/caddy/Caddyfile");
  await ssh("systemctl reload caddy || systemctl start caddy || true");
  console.log("   ✓ Caddy");

  console.log("\n🔄 Restarting...");
  await ssh("systemctl restart frak-sandbox-manager");

  await Bun.sleep(2000);
  try {
    await ssh("curl -sf http://localhost:4000/health/live");
    console.log("   ✓ Healthy");
  } catch {
    console.log("   ⚠ Health check failed");
  }

  console.log("\n✅ Done!");
}

async function addKeyToAgent(keyPath: string, passphrase: string) {
  const askpass = `/tmp/ssh-askpass-${process.pid}`;
  await Bun.write(askpass, `#!/bin/sh\necho '${passphrase.replace(/'/g, "'\\''")}'`);
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
