import * as p from "@clack/prompts";
import { loadConfig } from "@frak-sandbox/shared";
import { baseSetup } from "./commands/base-setup";
import { configCommand } from "./commands/config";
import { debugVm } from "./commands/debug-vm";
import { deployManager } from "./commands/deploy-manager";
import { images } from "./commands/images";
import { installFirecracker } from "./commands/install-firecracker";
import { setupNetwork } from "./commands/setup-network";

import { setupSshProxy } from "./commands/setup-ssh-proxy";
import { setupStorage } from "./commands/setup-storage";
import { updateServer } from "./commands/update";
import { printVersion } from "./commands/version";
import { isRoot } from "./lib/shell";

const COMMANDS = {
  setup: {
    label: "Full Setup",
    description:
      "Run complete server setup (base + firecracker + network + ssh-proxy)",
    handler: runFullSetup,
    requiresRoot: true,
  },
  base: {
    label: "Base Setup",
    description: "Install base packages, Bun, Docker, Caddy, verify KVM",
    handler: baseSetup,
    requiresRoot: true,
  },
  firecracker: {
    label: "Install Firecracker",
    description: "Download Firecracker, kernel, and rootfs",
    handler: installFirecracker,
    requiresRoot: true,
  },
  network: {
    label: "Setup Network",
    description: "Configure persistent bridge for VM networking",
    handler: setupNetwork,
    requiresRoot: true,
  },
  storage: {
    label: "Setup Storage",
    description: "Configure LVM thin provisioning",
    handler: setupStorage,
    requiresRoot: true,
  },
  "ssh-proxy": {
    label: "Setup SSH Proxy",
    description: "Install and configure sshpiper for sandbox SSH access",
    handler: setupSshProxy,
    requiresRoot: true,
  },
  manager: {
    label: "Manager API",
    description: "Deploy/manage the sandbox manager API",
    handler: deployManager,
    requiresRoot: true,
  },
  images: {
    label: "Images",
    description: "Build base images (Docker → ext4 → LVM)",
    handler: images,
    requiresRoot: true,
  },
  "debug-vm": {
    label: "Debug VM",
    description: "Start/stop/manage debug VM (isolated from Manager)",
    handler: debugVm,
    requiresRoot: true,
  },
  update: {
    label: "Update Server",
    description: "Download and install the matching server bundle",
    handler: updateServer,
    requiresRoot: true,
  },
  config: {
    label: "Config",
    description: "View and edit sandbox.config.json",
    handler: configCommand,
    requiresRoot: true,
  },
  version: {
    label: "Version",
    description: "Show CLI version",
    handler: printVersion,
    requiresRoot: false,
  },
} as const;

type CommandKey = keyof typeof COMMANDS;

async function runFullSetup() {
  p.log.info("Starting full server setup...\n");

  await baseSetup();
  await installFirecracker();
  await setupNetwork();
  await setupSshProxy();

  const config = loadConfig();
  const hasStorageConfig = !!config.setup?.storage?.method;

  if (hasStorageConfig) {
    await setupStorage();
  } else {
    const setupStorageNow = await p.confirm({
      message:
        "Setup LVM storage now? (requires dedicated partition or loop file)",
      initialValue: false,
    });

    if (p.isCancel(setupStorageNow)) {
      p.cancel("Setup cancelled");
      process.exit(0);
    }

    if (setupStorageNow) {
      await setupStorage();
    } else {
      p.log.info("Skipping storage setup. Run 'frak-sandbox storage' later.");
    }
  }

  p.log.success("Server setup complete!");
  p.note(
    `Server is ready. Next:
  1. Update server bundle: frak-sandbox update
  2. Build base image: frak-sandbox images build dev-base
  3. Test VM: frak-sandbox vm start
  4. API status: frak-sandbox manager status`,
    "Setup Complete",
  );
}

async function selectCommand(): Promise<CommandKey> {
  const command = await p.select({
    message: "What would you like to do?",
    options: Object.entries(COMMANDS).map(([key, { label, description }]) => ({
      value: key as CommandKey,
      label,
      hint: description,
    })),
  });

  if (p.isCancel(command)) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  return command;
}

function printHelp() {
  console.log(`
frak-sandbox - Firecracker sandbox management CLI

Usage: frak-sandbox [command] [subcommand]

PROVISIONING (one-time setup):
  setup           Run complete server setup (new servers)
  base            Install base packages, Bun, Docker, Caddy, verify KVM
  firecracker     Download Firecracker, kernel, and rootfs
  network         Configure persistent bridge for VM networking
  storage         Configure LVM thin provisioning
  ssh-proxy       Install and configure sshpiper for sandbox SSH access

UPDATES & CONFIG:
  update          Download and install the matching server bundle
  config          View or edit sandbox.config.json

SERVICE CONTROL:
  manager         Manage the sandbox manager API service

IMAGE BUILDING:
  images          Build base images (Docker -> ext4 -> LVM)

DEBUGGING:
  debug-vm        Start/stop/manage debug VM (isolated from Manager)

INFO:
  version         Show CLI version

Manager Subcommands:
  manager start   Start the manager service
  manager stop    Stop the manager service
  manager restart Restart the manager service
  manager status  Show service status and health
  manager logs    View manager logs (follows)

Images:
  images [image-id]   Build a base image (interactive or: images dev-base)

Debug VM Subcommands:
  debug-vm start      Start debug VM
  debug-vm stop       Stop debug VM
  debug-vm status     Show VM status
  debug-vm ssh        SSH into VM

Options:
  --help, -h      Show this help message
  --version, -v   Show CLI version

Examples:
  frak-sandbox setup              Prepare server (run once)
  frak-sandbox update             Install server bundle
  frak-sandbox update --rebuild-images
  frak-sandbox manager status     Check API health
  frak-sandbox images dev-base    Build dev-base image
  frak-sandbox debug-vm start     Start debug VM
  frak-sandbox config show        Show current config
  frak-sandbox version            Show CLI version

For runtime operations (sandbox list, resize, etc), use Manager API:
  curl http://localhost:4000/sandboxes
  curl http://localhost:4000/images
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    await printVersion();
    process.exit(0);
  }

  p.intro("frak-sandbox");

  let command: CommandKey;
  const subArgs = args.slice(1);

  if (args.length === 0) {
    command = await selectCommand();
  } else {
    const cmd = args[0] as CommandKey;
    if (!(cmd in COMMANDS)) {
      p.log.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
    }
    command = cmd;
  }

  try {
    const commandConfig = COMMANDS[command];

    if (commandConfig.requiresRoot && !(await isRoot())) {
      await reexecWithSudo([command, ...subArgs]);
      return;
    }

    await commandConfig.handler(subArgs);
    p.outro("Done!");
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();

async function reexecWithSudo(args: string[]) {
  const { commandExists } = await import("./lib/shell");

  if (!(await commandExists("sudo"))) {
    p.log.error("sudo is required for this command but is not installed.");
    process.exit(1);
  }

  p.log.info("Re-running with sudo...");
  const proc = Bun.spawn(["sudo", "-E", process.argv[0], ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  const code = await proc.exited;
  process.exit(code);
}
