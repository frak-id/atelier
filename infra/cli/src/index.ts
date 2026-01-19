import * as p from "@clack/prompts";
import { baseSetup } from "./commands/base-setup";
import { deployManager } from "./commands/deploy-manager";
import { images } from "./commands/images";
import { installFirecracker } from "./commands/install-firecracker";
import { setupNetwork } from "./commands/setup-network";
import { setupSshProxy } from "./commands/setup-ssh-proxy";
import { setupStorage } from "./commands/setup-storage";
import { testVm } from "./commands/test-vm";
import { isRoot } from "./lib/shell";

const COMMANDS = {
  setup: {
    label: "Full Setup",
    description:
      "Run complete server setup (base + firecracker + network + manager)",
    handler: runFullSetup,
  },
  base: {
    label: "Base Setup",
    description: "Install base packages, Bun, Docker, Caddy, verify KVM",
    handler: baseSetup,
  },
  firecracker: {
    label: "Install Firecracker",
    description: "Download Firecracker, kernel, and rootfs",
    handler: installFirecracker,
  },
  network: {
    label: "Setup Network",
    description: "Configure persistent bridge for VM networking",
    handler: setupNetwork,
  },
  storage: {
    label: "Setup Storage",
    description: "Configure LVM thin provisioning",
    handler: setupStorage,
  },
  "ssh-proxy": {
    label: "Setup SSH Proxy",
    description: "Install and configure sshpiper for sandbox SSH access",
    handler: setupSshProxy,
  },
  manager: {
    label: "Manager API",
    description: "Deploy/manage the sandbox manager API",
    handler: deployManager,
  },
  images: {
    label: "Images",
    description: "Build and manage base images",
    handler: images,
  },
  vm: {
    label: "Test VM",
    description: "Start/stop/manage test VM",
    handler: testVm,
  },
} as const;

type CommandKey = keyof typeof COMMANDS;

async function runFullSetup() {
  p.log.info("Starting full server setup...\n");

  await baseSetup();
  await installFirecracker();
  await setupNetwork();

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

  p.log.success("Server setup complete!");
  p.note(
    `Server is ready. Next:
  1. From dev machine: bun run deploy
  2. Test VM: frak-sandbox vm start
  3. API status: frak-sandbox manager status`,
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

Commands:
  setup           Run complete server setup (new servers)
  base            Install base packages, Bun, Docker, Caddy, verify KVM
  firecracker     Download Firecracker, kernel, and rootfs
  network         Configure persistent bridge for VM networking
  storage         Configure LVM thin provisioning
  ssh-proxy       Install and configure sshpiper for sandbox SSH access
  manager         Manage the sandbox manager API service
  images          Build and manage base images
  vm              Start/stop/manage test VM

Manager Subcommands:
  manager start   Start the manager service
  manager stop    Stop the manager service
  manager restart Restart the manager service
  manager status  Show service status and health
  manager logs    View manager logs (follows)

Images Subcommands:
  images build    Build a base image (interactive or: images build dev-base)
  images list     List available base images
  images status   Check which images are built

VM Subcommands:
  vm start        Start test VM
  vm stop         Stop test VM
  vm status       Show VM status
  vm ssh          SSH into VM

Options:
  --help, -h      Show this help message

Examples:
  frak-sandbox setup            Prepare server (run once)
  frak-sandbox manager status   Check API health
  frak-sandbox manager logs     Follow API logs
  frak-sandbox images build     Build base image
  frak-sandbox vm start         Start test VM
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (!(await isRoot())) {
    p.log.error("This tool must be run as root (use sudo)");
    process.exit(1);
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
    await COMMANDS[command].handler(subArgs);
    p.outro("Done!");
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
