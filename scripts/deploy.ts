#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");
const CLI_DIR = resolve(ROOT, "infra/cli");
const ENV_FILE = resolve(ROOT, ".env");

async function main() {
  if (!existsSync(ENV_FILE)) {
    console.error("Missing .env file. Copy .env.example and fill in your values:");
    console.error("  cp .env.example .env");
    process.exit(1);
  }

  const env = await Bun.file(ENV_FILE).text();
  const config = Object.fromEntries(
    env
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const idx = line.indexOf("=");
        if (idx === -1) return [line.trim(), ""];
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
      })
  );

  const { SSH_KEY_PATH, SSH_USER, SSH_HOST, SSH_KEY_PASSPHRASE } = config;

  if (!SSH_KEY_PATH || !SSH_USER || !SSH_HOST) {
    console.error("Missing required env vars: SSH_KEY_PATH, SSH_USER, SSH_HOST");
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

  console.log("Building Linux executable...");
  await $`cd ${CLI_DIR} && bun run build:linux`;

  const binary = resolve(CLI_DIR, "dist/frak-sandbox-linux-x64");
  const remotePath = "/usr/local/bin/frak-sandbox";

  const tempPath = "/tmp/frak-sandbox-upload";

  console.log(`\nUploading to ${SSH_USER}@${SSH_HOST}...`);
  await $`scp -i ${SSH_KEY_PATH} ${binary} ${SSH_USER}@${SSH_HOST}:${tempPath}`;

  console.log("Installing binary...");
  await $`ssh -i ${SSH_KEY_PATH} ${SSH_USER}@${SSH_HOST} ${"mv " + tempPath + " " + remotePath + " && chmod +x " + remotePath}`;

  console.log("\n✅ Deployed successfully!");
  console.log(`\nRun on server:`);
  console.log(`  ssh -i '${SSH_KEY_PATH}' ${SSH_USER}@${SSH_HOST} frak-sandbox`);
}

async function addKeyToAgent(keyPath: string, passphrase: string) {
  const askpassScript = `/tmp/ssh-askpass-${process.pid}`;
  
  await Bun.write(askpassScript, `#!/bin/sh\necho '${passphrase.replace(/'/g, "'\\''")}'`);
  await $`chmod +x ${askpassScript}`;

  try {
    await $`SSH_ASKPASS=${askpassScript} SSH_ASKPASS_REQUIRE=force ssh-add ${keyPath}`.env({
      ...process.env,
      SSH_ASKPASS: askpassScript,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: ":0",
    });
  } finally {
    await $`rm -f ${askpassScript}`.quiet();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
