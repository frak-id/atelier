import { randomBytes } from "node:crypto";
import * as p from "@clack/prompts";
import {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  loadConfig,
  validateConfig,
} from "@frak-sandbox/shared";
import { fileExists } from "../lib/shell";
import { baseSetup } from "./base-setup";
import { images } from "./images";
import { installFirecracker } from "./install-firecracker";
import { setupNetwork } from "./setup-network";
import { setupSshProxy } from "./setup-ssh-proxy";
import { setupStorage } from "./setup-storage";
import { updateServer } from "./update";

export async function initServer(_args: string[] = []) {
  p.log.info("Starting full installation...\n");

  await ensureConfig();

  await baseSetup();
  await installFirecracker();
  await setupNetwork();
  await setupSshProxy();

  const storageRan = await runStorageSetup();

  await updateServer();

  if (storageRan) {
    const buildNow = await p.confirm({
      message: "Build base image now? (recommended)",
      initialValue: true,
    });

    if (!p.isCancel(buildNow) && buildNow) {
      await images(["dev-base"]);
    }
  }

  p.log.success("Installation complete!");
  p.note(
    `Next steps:
  1. Check API health: frak-sandbox manager status
  2. Build image later: frak-sandbox images dev-base`,
    "Install Complete",
  );
}

async function ensureConfig() {
  const configPath = getConfigPath();
  const exists = await fileExists(configPath);

  if (exists) {
    const useExisting = await p.confirm({
      message: `Config found at ${configPath}. Use it?`,
      initialValue: true,
    });

    if (p.isCancel(useExisting) || useExisting) {
      await validateConfigFile(configPath);
      return;
    }
  }

  const config = await promptConfig();
  await Bun.write(configPath, JSON.stringify(config, null, 2));
  await validateConfigFile(configPath);
}

async function promptConfig() {
  p.log.info("Configuring sandbox settings...");

  const domainSuffix = await promptText("Domain suffix", "example.com");
  const dashboardDomain = await promptText(
    "Dashboard domain",
    `sandbox.${domainSuffix}`,
  );
  const sshDomain = await promptText("SSH proxy domain", `ssh.${domainSuffix}`);
  const tlsEmail = await promptText("TLS email", `admin@${domainSuffix}`);

  const githubClientId = await promptText("GitHub Client ID", "");
  const githubClientSecret = await promptText("GitHub Client Secret", "");
  const allowedOrg = await promptText("Allowed GitHub org (optional)", "");
  const allowedUsersRaw = await promptText(
    "Allowed GitHub users (comma-separated, optional)",
    "",
  );

  const defaultJwt = randomBytes(32).toString("hex");
  const jwtSecret = await promptText("JWT secret", defaultJwt);

  const allowedUsers = allowedUsersRaw
    .split(",")
    .map((user) => user.trim())
    .filter(Boolean);

  const config = structuredClone(DEFAULT_CONFIG);

  config.domains = {
    dashboard: dashboardDomain,
    sandboxSuffix: domainSuffix,
    ssh: sshDomain,
  };

  config.network = { ...DEFAULT_CONFIG.network };
  config.services = { ...DEFAULT_CONFIG.services };

  config.auth = {
    ...DEFAULT_CONFIG.auth,
    githubClientId,
    githubClientSecret,
    githubCallbackUrl: `https://${dashboardDomain}/api/github/callback`,
    githubLoginCallbackUrl: `https://${dashboardDomain}/auth/callback`,
    jwtSecret,
    allowedOrg: allowedOrg.trim().length > 0 ? allowedOrg : undefined,
    allowedUsers,
  };

  config.sshProxy = { ...DEFAULT_CONFIG.sshProxy, domain: sshDomain };
  config.runtime = { ...DEFAULT_CONFIG.runtime, mode: "production" };
  config.tls = { ...DEFAULT_CONFIG.tls, email: tlsEmail };

  return config;
}

async function promptText(message: string, initialValue: string) {
  const response = await p.text({
    message,
    initialValue,
  });

  if (p.isCancel(response)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  return response.trim();
}

async function runStorageSetup(): Promise<boolean> {
  const config = loadConfig({ configFile: getConfigPath() });
  const hasStorageConfig = !!config.setup?.storage?.method;

  if (hasStorageConfig) {
    await setupStorage();
    return true;
  }

  const setupStorageNow = await p.confirm({
    message: "Setup LVM storage now? (recommended)",
    initialValue: true,
  });

  if (p.isCancel(setupStorageNow)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }

  if (setupStorageNow) {
    await setupStorage();
    return true;
  }

  p.log.info("Skipping storage setup. Run 'frak-sandbox storage' later.");
  return false;
}

async function validateConfigFile(configPath: string) {
  const config = loadConfig({ configFile: configPath });
  const errors = validateConfig(config, {
    requireAuth: true,
    requireDomains: true,
  });

  if (errors.length === 0) return;

  p.log.error("Config validation errors:");
  for (const err of errors) {
    console.log(`- ${err.field}: ${err.message}`);
  }
  throw new Error("Config validation failed");
}

function getConfigPath(): string {
  return process.env.FRAK_CONFIG || `/etc/frak-sandbox/${CONFIG_FILE_NAME}`;
}
