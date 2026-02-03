import * as p from "@clack/prompts";
import { CONFIG_FILE_NAME, loadConfig } from "@frak-sandbox/shared";
import { PATHS } from "../lib/context";
import { commandExists, exec, fileExists } from "../lib/shell";
import { images } from "./images";
import { CLI_VERSION } from "../version";

const DEFAULT_REPO = "frak-id/oc-sandbox";

export async function updateServer(args: string[] = []) {
  p.log.step("Update Server Bundle");

  if (!(await commandExists("curl"))) {
    throw new Error("curl is required. Install it first (apt-get install -y curl).");
  }
  if (!(await commandExists("tar"))) {
    throw new Error("tar is required. Install it first (apt-get install -y tar).");
  }

  const rebuildImages = args.includes("--rebuild-images");

  const version = CLI_VERSION;
  const repo = process.env.FRAK_RELEASE_REPO || DEFAULT_REPO;
  const baseUrl =
    process.env.FRAK_RELEASE_BASE_URL ||
    `https://github.com/${repo}/releases/download/v${version}`;
  const tarballName = `frak-sandbox-server-${version}.tar.gz`;
  const tarballUrl = `${baseUrl}/${tarballName}`;
  const checksumsUrl = `${baseUrl}/checksums.txt`;

  const tmpDir = `/tmp/frak-sandbox-update-${Date.now()}`;
  const extractDir = `${tmpDir}/extract`;
  const tarballPath = `${tmpDir}/${tarballName}`;
  const checksumsPath = `${tmpDir}/checksums.txt`;

  const agentPath = `${PATHS.APP_DIR}/infra/images/sandbox-agent`;
  const beforeHash = await getSha256(agentPath);

  const spinner = p.spinner();
  spinner.start(`Downloading ${tarballName}`);
  await exec(`mkdir -p ${tmpDir}`);
  await exec(`curl -fsSL ${tarballUrl} -o ${tarballPath}`);
  spinner.stop("Server bundle downloaded");

  const checksumFetch = await exec(`curl -fsSL ${checksumsUrl} -o ${checksumsPath}`, {
    throws: false,
  });

  if (checksumFetch.success) {
    const expected = await readChecksum(checksumsPath, tarballName);
    if (expected) {
      const actual = await getSha256(tarballPath);
      if (!actual || actual !== expected) {
        throw new Error("Checksum mismatch for server bundle");
      }
      p.log.success("Checksum verified");
    } else {
      p.log.warn("Checksum file found but entry missing for server bundle");
    }
  } else {
    p.log.warn("No checksums.txt found; skipping checksum verification");
  }

  spinner.start("Extracting bundle");
  await exec(`mkdir -p ${extractDir}`);
  await exec(`tar -xzf ${tarballPath} -C ${extractDir}`);
  spinner.stop("Bundle extracted");

  spinner.start("Installing files");
  await exec("systemctl stop frak-sandbox-manager || true", {
    throws: false,
  });
  await exec(
    "mkdir -p /opt/frak-sandbox/infra/images /opt/frak-sandbox/apps/dashboard /opt/frak-sandbox/drizzle /etc/systemd/system /etc/caddy",
  );

  await exec(`cp ${extractDir}/opt/frak-sandbox/server.js /opt/frak-sandbox/server.js`);
  await exec(
    `cp -r ${extractDir}/opt/frak-sandbox/drizzle/. /opt/frak-sandbox/drizzle/`,
  );
  await exec(
    `cp -r ${extractDir}/opt/frak-sandbox/apps/dashboard/dist/. /opt/frak-sandbox/apps/dashboard/dist/`,
  );
  await exec(
    `cp -r ${extractDir}/opt/frak-sandbox/infra/images/. /opt/frak-sandbox/infra/images/`,
  );
  await exec("chmod +x /opt/frak-sandbox/infra/images/build-image.sh", {
    throws: false,
  });
  await exec(
    `cp ${extractDir}/etc/systemd/system/frak-sandbox-manager.service /etc/systemd/system/frak-sandbox-manager.service`,
  );
  await exec(
    `cp ${extractDir}/etc/systemd/system/frak-sandbox-network.service /etc/systemd/system/frak-sandbox-network.service`,
  );
  await exec(
    `cp ${extractDir}/etc/caddy/Caddyfile.template /etc/caddy/Caddyfile.template`,
  );
  await exec("chown -R frak:frak /opt/frak-sandbox", { throws: false });
  spinner.stop("Files installed");

  await renderCaddyConfig();

  spinner.start("Reloading services");
  await exec("systemctl daemon-reload");
  await exec("systemctl enable frak-sandbox-network frak-sandbox-manager", {
    throws: false,
  });
  await exec("systemctl reload caddy || systemctl start caddy || true", {
    throws: false,
  });
  await exec("systemctl restart frak-sandbox-manager");
  spinner.stop("Services reloaded");

  await exec(`rm -rf ${tmpDir}`, { throws: false });

  const afterHash = await getSha256(agentPath);
  const agentChanged =
    beforeHash && afterHash && beforeHash !== afterHash ? true : false;

  if (rebuildImages) {
    await images(["dev-base"]);
  } else if (agentChanged) {
    const confirm = await p.confirm({
      message:
        "Sandbox agent changed. Rebuild the base image now? (recommended)",
      initialValue: true,
    });
    if (!p.isCancel(confirm) && confirm) {
      await images(["dev-base"]);
    }
  }

  p.log.success(`Server bundle updated to v${version}`);
}

async function renderCaddyConfig() {
  const configPath =
    process.env.FRAK_CONFIG || `/etc/frak-sandbox/${CONFIG_FILE_NAME}`;

  if (!(await fileExists(configPath))) {
    throw new Error(
      `Config file not found: ${configPath}. Run 'frak-sandbox config set' or reinstall.`,
    );
  }

  const config = loadConfig({ configFile: configPath });
  const templatePath = "/etc/caddy/Caddyfile.template";
  const template = await Bun.file(templatePath).text();

  const useManualTls =
    config.tls.certPath.trim().length > 0 &&
    config.tls.keyPath.trim().length > 0;

  let output = template
    .replace(/{{SSL_EMAIL}}/g, config.tls.email || "")
    .replace(/{{API_DOMAIN}}/g, config.domains.api)
    .replace(/{{DASHBOARD_DOMAIN}}/g, config.domains.dashboard)
    .replace(/{{DOMAIN_SUFFIX}}/g, config.domains.sandboxSuffix);

  if (useManualTls) {
    output = output
      .replace(/{{#MANUAL_TLS}}/g, "")
      .replace(/{{\/MANUAL_TLS}}/g, "")
      .replace(/{{TLS_CERT_PATH}}/g, config.tls.certPath)
      .replace(/{{TLS_KEY_PATH}}/g, config.tls.keyPath)
      .replace(/{{TLS_CONFIG}}/g, "import tls_manual");
  } else {
    output = output.replace(
      /{{#MANUAL_TLS}}[\s\S]*?{{\/MANUAL_TLS}}\n?/g,
      "",
    );
    output = output.replace(/{{TLS_CONFIG}}/g, "");
    output = output.replace(/{{TLS_CERT_PATH}}|{{TLS_KEY_PATH}}/g, "");
  }

  await Bun.write("/etc/caddy/Caddyfile", output);
}

async function getSha256(path: string): Promise<string | null> {
  const exists = await fileExists(path);
  if (!exists) return null;

  const result = await exec(`sha256sum ${path}`, { throws: false });
  if (!result.success) return null;
  return result.stdout.split(" ")[0] ?? null;
}

async function readChecksum(
  checksumsPath: string,
  fileName: string,
): Promise<string | null> {
  try {
    const content = await Bun.file(checksumsPath).text();
    const line = content
      .split("\n")
      .find((entry) => entry.trim().endsWith(` ${fileName}`));
    if (!line) return null;
    return line.trim().split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}
