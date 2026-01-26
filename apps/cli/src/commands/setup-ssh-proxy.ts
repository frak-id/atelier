import * as p from "@clack/prompts";
import { SSH_PROXY } from "@frak-sandbox/shared/constants";
import { exec, fileExists, getArch } from "../lib/shell";

export async function setupSshProxy(_args: string[] = []) {
  p.log.step("Setting up SSH Proxy (sshpiper)");

  const spinner = p.spinner();

  const binaryExists = await fileExists(SSH_PROXY.BINARY_PATH);
  if (binaryExists) {
    const { stdout } = await exec(`${SSH_PROXY.BINARY_PATH} version`, {
      throws: false,
    });
    p.log.success(`sshpiper already installed: ${stdout.split("\n")[0]}`);
  } else {
    spinner.start("Downloading sshpiper");

    const arch = await getArch();
    const archMap: Record<string, string> = {
      x86_64: "x86_64",
      aarch64: "arm64",
    };
    const releaseArch = archMap[arch] ?? "x86_64";

    const tarball = `sshpiperd_with_plugins_linux_${releaseArch}.tar.gz`;
    const url = `https://github.com/tg123/sshpiper/releases/download/v${SSH_PROXY.VERSION}/${tarball}`;

    await exec(
      "rm -rf /tmp/sshpiper-install && mkdir -p /tmp/sshpiper-install",
    );
    await exec(`curl -fsSL ${url} -o /tmp/sshpiper-install/sshpiper.tar.gz`);
    await exec(
      "tar -xzf /tmp/sshpiper-install/sshpiper.tar.gz -C /tmp/sshpiper-install",
    );
    await exec(
      `find /tmp/sshpiper-install -name sshpiperd -type f -exec mv {} ${SSH_PROXY.BINARY_PATH} \\;`,
    );
    await exec(`chmod +x ${SSH_PROXY.BINARY_PATH}`);
    await exec(
      "find /tmp/sshpiper-install -path '*/plugins/*' -type f -exec mv {} /usr/local/bin/ \\;",
    );
    await exec("chmod +x /usr/local/bin/yaml 2>/dev/null || true");
    await exec("rm -rf /tmp/sshpiper-install");

    spinner.stop("sshpiper installed");
  }

  spinner.start("Creating configuration directory");
  await exec(`mkdir -p ${SSH_PROXY.CONFIG_DIR}`);
  await exec(`chmod 700 ${SSH_PROXY.CONFIG_DIR}`);
  spinner.stop("Configuration directory created");

  const hostKeyExists = await fileExists(SSH_PROXY.HOST_KEY);
  if (hostKeyExists) {
    p.log.success("Host key already exists");
  } else {
    spinner.start("Generating host key");
    await exec(
      `ssh-keygen -t ed25519 -f ${SSH_PROXY.HOST_KEY} -N "" -C "sshpiper-host"`,
    );
    await exec(`chmod 600 ${SSH_PROXY.HOST_KEY}`);
    spinner.stop("Host key generated");
  }

  const pipesExists = await fileExists(SSH_PROXY.PIPES_FILE);
  if (!pipesExists) {
    spinner.start("Creating initial pipes configuration");
    const initialConfig = `# sshpiper pipes configuration
# Managed by frak-sandbox manager - do not edit manually
version: "1.0"
pipes: []
`;
    await Bun.write(SSH_PROXY.PIPES_FILE, initialConfig);
    await exec(`chmod 600 ${SSH_PROXY.PIPES_FILE}`);
    spinner.stop("Pipes configuration created");
  } else {
    p.log.success("Pipes configuration already exists");
  }

  spinner.start("Setting up systemd service");
  const serviceContent = `[Unit]
Description=sshpiper SSH proxy for sandbox routing
After=network.target

[Service]
Type=simple
ExecStart=${SSH_PROXY.BINARY_PATH} \\
  -i ${SSH_PROXY.HOST_KEY} \\
  -l 0.0.0.0 \\
  -p ${SSH_PROXY.LISTEN_PORT} \\
  --log-level info \\
  yaml \\
  --config ${SSH_PROXY.PIPES_FILE}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

  await Bun.write("/etc/systemd/system/sshpiper.service", serviceContent);
  await exec("systemctl daemon-reload");
  await exec("systemctl enable sshpiper");
  spinner.stop("Systemd service configured");

  const isRunning = await exec("systemctl is-active sshpiper", {
    throws: false,
  });
  if (isRunning.success) {
    spinner.start("Restarting sshpiper");
    await exec("systemctl restart sshpiper");
    spinner.stop("sshpiper restarted");
  } else {
    spinner.start("Starting sshpiper");
    await exec("systemctl start sshpiper");
    spinner.stop("sshpiper started");
  }

  await exec("sleep 1");
  const status = await exec("systemctl is-active sshpiper", { throws: false });
  if (!status.success) {
    const logs = await exec("journalctl -u sshpiper -n 20 --no-pager", {
      throws: false,
    });
    p.log.error("sshpiper failed to start. Recent logs:");
    console.log(logs.stdout || logs.stderr);
    throw new Error("sshpiper failed to start");
  }

  p.log.success("SSH Proxy setup complete");
  p.note(
    `sshpiper listening on port ${SSH_PROXY.LISTEN_PORT}
Config: ${SSH_PROXY.PIPES_FILE}
Host key: ${SSH_PROXY.HOST_KEY}

Users can connect with:
  ssh <sandbox-id>@${SSH_PROXY.DOMAIN}

Make sure to:
  1. Configure DNS: ${SSH_PROXY.DOMAIN} → this server
  2. Open firewall port ${SSH_PROXY.LISTEN_PORT}`,
    "Summary",
  );
}
