import * as p from "@clack/prompts";
import { exec, fileExists } from "../lib/shell";
import { PATHS } from "../lib/context";

const MANAGER_SERVICE = "frak-sandbox-manager";
const MANAGER_PORT = 4000;

export async function deployManager(args: string[] = []) {
  const subcommand = args[0];

  if (!subcommand) {
    const action = await p.select({
      message: "Manager action:",
      options: [
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

    await runAction(action);
  } else {
    await runAction(subcommand);
  }
}

async function runAction(action: string) {
  switch (action) {
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
      p.log.info("Available: start, stop, restart, status, logs");
  }
}

async function startService() {
  const serverExists = await fileExists(`${PATHS.APP_DIR}/server.js`);
  if (!serverExists) {
    throw new Error("server.js not found. Deploy the manager first using 'bun run deploy'");
  }

  const spinner = p.spinner();
  spinner.start("Starting manager service");
  await exec(`systemctl start ${MANAGER_SERVICE}`);
  await Bun.sleep(1500);

  const healthy = await checkHealth();
  spinner.stop(healthy ? "Manager started and healthy" : "Manager started");
}

async function stopService() {
  const spinner = p.spinner();
  spinner.start("Stopping manager service");
  await exec(`systemctl stop ${MANAGER_SERVICE}`);
  spinner.stop("Manager stopped");
}

async function restartService() {
  const spinner = p.spinner();
  spinner.start("Restarting manager service");
  await exec(`systemctl restart ${MANAGER_SERVICE}`);
  await Bun.sleep(1500);

  const healthy = await checkHealth();
  spinner.stop(healthy ? "Manager restarted and healthy" : "Manager restarted");
}

async function checkHealth(): Promise<boolean> {
  const result = await exec(`curl -sf http://localhost:${MANAGER_PORT}/health/live`, { throws: false });
  return result.success;
}

async function showStatus() {
  console.log("");

  const serviceStatus = await exec(`systemctl is-active ${MANAGER_SERVICE}`, { throws: false });
  const isRunning = serviceStatus.success;

  console.log("Service Status:");
  console.log("---------------");
  console.log(`  Systemd: ${isRunning ? "✓ running" : "✗ stopped"}`);

  if (isRunning) {
    const health = await exec(`curl -sf http://localhost:${MANAGER_PORT}/health`, { throws: false });

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
        console.log("  Health:  ✓ responding");
      }
    } else {
      console.log("  Health:  ✗ not responding");
    }
  }

  console.log("");
  console.log("Commands:");
  console.log(`  journalctl -u ${MANAGER_SERVICE} -f`);
  console.log("");
}

async function showLogs() {
  const { execLive } = await import("../lib/shell");
  await execLive(`journalctl -u ${MANAGER_SERVICE} -f --no-pager -n 50`);
}
