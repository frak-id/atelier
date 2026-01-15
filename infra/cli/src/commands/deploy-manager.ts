import * as p from "@clack/prompts";
import { exec, fileExists, commandExists } from "../lib/shell";
import { PATHS } from "../lib/context";

const MANAGER_SERVICE = "frak-sandbox-manager";
const NETWORK_SERVICE = "frak-sandbox-network";
const MANAGER_PORT = 4000;

export async function deployManager(args: string[] = []) {
  const subcommand = args[0];

  if (!subcommand) {
    const action = await p.select({
      message: "Manager action:",
      options: [
        { value: "deploy", label: "Deploy", hint: "Deploy/update manager API" },
        { value: "start", label: "Start", hint: "Start the manager service" },
        { value: "stop", label: "Stop", hint: "Stop the manager service" },
        { value: "restart", label: "Restart", hint: "Restart the manager service" },
        { value: "status", label: "Status", hint: "Show service status" },
        { value: "logs", label: "Logs", hint: "View manager logs" },
      ],
    });

    if (p.isCancel(action)) {
      p.cancel("Cancelled");
      return;
    }

    await runAction(action, args.slice(1));
  } else {
    await runAction(subcommand, args.slice(1));
  }
}

async function runAction(action: string, _args: string[]) {
  switch (action) {
    case "deploy":
      await deploy();
      break;
    case "start":
      await startService();
      break;
    case "stop":
      await stopService();
      break;
    case "restart":
      await restartService();
      break;
    case "status":
      await showStatus();
      break;
    case "logs":
      await showLogs();
      break;
    default:
      p.log.error(`Unknown action: ${action}`);
      p.log.info("Available: deploy, start, stop, restart, status, logs");
  }
}

async function deploy() {
  p.log.step("Deploying Frak Sandbox Manager");

  const spinner = p.spinner();

  spinner.start("Checking prerequisites");
  await checkPrerequisites();
  spinner.stop("Prerequisites verified");

  spinner.start("Syncing application code");
  await syncCode();
  spinner.stop("Code synced to /opt/frak-sandbox");

  spinner.start("Installing dependencies");
  await exec(`cd ${PATHS.APP_DIR}/apps/manager && /root/.bun/bin/bun install --frozen-lockfile`);
  spinner.stop("Dependencies installed");

  spinner.start("Installing systemd services");
  await installSystemdServices();
  spinner.stop("Systemd services installed");

  spinner.start("Configuring Caddy");
  await configureCaddy();
  spinner.stop("Caddy configured");

  spinner.start("Starting manager service");
  await exec(`systemctl start ${MANAGER_SERVICE}`);
  await Bun.sleep(2000);

  const healthy = await checkHealth();
  if (healthy) {
    spinner.stop("Manager service started and healthy");
  } else {
    spinner.stop("Manager service started (health check pending)");
  }

  p.log.success("Manager deployed successfully");
  p.note(
    `API: http://localhost:${MANAGER_PORT}
Swagger: http://localhost:${MANAGER_PORT}/swagger
Service: systemctl status ${MANAGER_SERVICE}
Logs: journalctl -u ${MANAGER_SERVICE} -f`,
    "Manager Info"
  );
}

async function checkPrerequisites() {
  if (!(await commandExists("bun"))) {
    const bunExists = await exec("test -x /root/.bun/bin/bun", { throws: false });
    if (!bunExists.success) {
      throw new Error("Bun not installed. Run 'frak-sandbox base' first.");
    }
  }

  if (!(await commandExists("systemctl"))) {
    throw new Error("systemd not available");
  }
}

async function syncCode() {
  await exec(`mkdir -p ${PATHS.APP_DIR}`);

  const currentDir = process.cwd();
  const isInRepo = await fileExists(`${currentDir}/apps/manager/package.json`);

  if (isInRepo) {
    await exec(`rsync -a --delete --exclude 'node_modules' --exclude '.git' --exclude 'dist' ${currentDir}/ ${PATHS.APP_DIR}/`);
  } else {
    const repoExists = await fileExists(`${PATHS.APP_DIR}/apps/manager/package.json`);
    if (!repoExists) {
      throw new Error(
        "Repository not found. Either run from the repo directory or clone to /opt/frak-sandbox first."
      );
    }
    p.log.info("Using existing code at /opt/frak-sandbox");
  }
}

async function installSystemdServices() {
  const serviceFiles = [
    { name: NETWORK_SERVICE, file: "frak-sandbox-network.service" },
    { name: MANAGER_SERVICE, file: "frak-sandbox-manager.service" },
  ];

  for (const { name, file } of serviceFiles) {
    const sourcePath = `${PATHS.APP_DIR}/infra/systemd/${file}`;
    const destPath = `/etc/systemd/system/${file}`;

    if (await fileExists(sourcePath)) {
      await exec(`cp ${sourcePath} ${destPath}`);
      await exec(`chmod 644 ${destPath}`);
    } else {
      p.log.warn(`Service file not found: ${sourcePath}`);
    }
  }

  await exec("systemctl daemon-reload");

  await exec(`systemctl enable ${NETWORK_SERVICE}`, { throws: false });
  await exec(`systemctl enable ${MANAGER_SERVICE}`, { throws: false });
}

async function configureCaddy() {
  const caddyfileSource = `${PATHS.APP_DIR}/infra/caddy/Caddyfile`;
  const caddyfileDest = "/etc/caddy/Caddyfile";

  if (await fileExists(caddyfileSource)) {
    const backup = await fileExists(caddyfileDest);
    if (backup) {
      await exec(`cp ${caddyfileDest} ${caddyfileDest}.backup`);
    }

    await exec(`cp ${caddyfileSource} ${caddyfileDest}`);

    const caddyRunning = await exec("systemctl is-active caddy", { throws: false });
    if (caddyRunning.success) {
      await exec("systemctl reload caddy");
    } else {
      await exec("systemctl start caddy");
    }
  }
}

async function checkHealth(): Promise<boolean> {
  const result = await exec(
    `curl -sf http://localhost:${MANAGER_PORT}/health/live`,
    { throws: false }
  );
  return result.success;
}

async function startService() {
  const spinner = p.spinner();
  spinner.start("Starting manager service");
  await exec(`systemctl start ${MANAGER_SERVICE}`);
  spinner.stop("Manager service started");
}

async function stopService() {
  const spinner = p.spinner();
  spinner.start("Stopping manager service");
  await exec(`systemctl stop ${MANAGER_SERVICE}`);
  spinner.stop("Manager service stopped");
}

async function restartService() {
  const spinner = p.spinner();
  spinner.start("Restarting manager service");
  await exec(`systemctl restart ${MANAGER_SERVICE}`);
  spinner.stop("Manager service restarted");
}

async function showStatus() {
  console.log("");

  const serviceStatus = await exec(`systemctl is-active ${MANAGER_SERVICE}`, { throws: false });
  const isRunning = serviceStatus.success;

  console.log("Service Status:");
  console.log("---------------");
  console.log(`  Systemd: ${isRunning ? "✓ running" : "✗ stopped"}`);

  if (isRunning) {
    const health = await exec(
      `curl -sf http://localhost:${MANAGER_PORT}/health`,
      { throws: false }
    );

    if (health.success) {
      try {
        const data = JSON.parse(health.stdout);
        console.log(`  Health:  ${data.status === "ok" ? "✓ healthy" : "⚠ degraded"}`);
        console.log(`  Uptime:  ${data.uptime}s`);
        console.log("  Checks:");
        for (const [key, value] of Object.entries(data.checks || {})) {
          console.log(`    - ${key}: ${value === "ok" ? "✓" : "✗"}`);
        }
      } catch {
        console.log(`  Health:  ✓ responding`);
      }
    } else {
      console.log(`  Health:  ✗ not responding`);
    }
  }

  console.log("");
  console.log("Quick commands:");
  console.log(`  Logs:    journalctl -u ${MANAGER_SERVICE} -f`);
  console.log(`  Restart: systemctl restart ${MANAGER_SERVICE}`);
  console.log("");
}

async function showLogs() {
  const { execLive } = await import("../lib/shell");
  await execLive(`journalctl -u ${MANAGER_SERVICE} -f --no-pager -n 50`);
}
