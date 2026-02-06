import * as p from "@clack/prompts";
import { CONFIG_FILE_NAME, loadConfig } from "@frak/atelier-shared";
import { PATHS } from "../lib/context";
import { commandExists, exec, fileExists } from "../lib/shell";
import { CLI_VERSION } from "../version";
import { images } from "./images";

const DEFAULT_REPO = "frak-id/oc-sandbox";
const DEFAULT_LOCAL_TARBALL = "/tmp/atelier-deploy.tar.gz";

type DeploySource =
  | { type: "github"; tarballUrl: string; checksumsUrl: string }
  | { type: "local"; tarballPath: string };

export async function updateServer(args: string[] = []) {
  p.log.step("Update Server Bundle");

  if (!(await commandExists("tar"))) {
    throw new Error(
      "tar is required. Install it first (apt-get install -y tar).",
    );
  }

  const rebuildImages = args.includes("--rebuild-images");
  const source = await resolveDeploySource(args);

  const tmpDir = `/tmp/atelier-update-${Date.now()}`;
  const extractDir = `${tmpDir}/extract`;

  const agentPath = `${PATHS.APP_DIR}/infra/images/sandbox-agent`;
  const beforeHash = await getSha256(agentPath);

  const spinner = p.spinner();
  let tarballPath: string;

  if (source.type === "github") {
    if (!(await commandExists("curl"))) {
      throw new Error(
        "curl is required for GitHub downloads. Install it first (apt-get install -y curl).",
      );
    }

    const tarballName = source.tarballUrl.split("/").pop() ?? "bundle.tar.gz";
    tarballPath = `${tmpDir}/${tarballName}`;
    const checksumsPath = `${tmpDir}/checksums.txt`;

    spinner.start(`Downloading ${tarballName}`);
    await exec(`mkdir -p ${tmpDir}`);
    await exec(`curl -fsSL ${source.tarballUrl} -o ${tarballPath}`);
    spinner.stop("Server bundle downloaded");

    const checksumFetch = await exec(
      `curl -fsSL ${source.checksumsUrl} -o ${checksumsPath}`,
      { throws: false },
    );

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
  } else {
    tarballPath = source.tarballPath;
    p.log.info(`Using local tarball: ${tarballPath}`);
    await exec(`mkdir -p ${tmpDir}`);
  }

  spinner.start("Extracting bundle");
  await exec(`mkdir -p ${extractDir}`);
  await exec(`tar -xzf ${tarballPath} -C ${extractDir}`);
  spinner.stop("Bundle extracted");

  spinner.start("Installing files");
  await exec("systemctl stop atelier-manager || true", {
    throws: false,
  });
  await exec(
    "mkdir -p /opt/atelier/infra/images /opt/atelier/apps/dashboard /opt/atelier/drizzle /etc/systemd/system /etc/caddy",
  );

  await exec(`cp ${extractDir}/opt/atelier/server.js /opt/atelier/server.js`);
  await exec(`cp -r ${extractDir}/opt/atelier/drizzle/. /opt/atelier/drizzle/`);
  await exec(
    `cp -r ${extractDir}/opt/atelier/apps/dashboard/dist/. /opt/atelier/apps/dashboard/dist/`,
  );
  await exec(
    `cp -r ${extractDir}/opt/atelier/infra/images/. /opt/atelier/infra/images/`,
  );
  await exec("chmod +x /opt/atelier/infra/images/build-image.sh", {
    throws: false,
  });
  await exec(
    `cp ${extractDir}/etc/systemd/system/atelier-manager.service /etc/systemd/system/atelier-manager.service`,
  );
  await exec(
    `cp ${extractDir}/etc/systemd/system/atelier-network.service /etc/systemd/system/atelier-network.service`,
  );

  const hasTemplate = await fileExists(
    `${extractDir}/etc/caddy/Caddyfile.template`,
  );
  if (hasTemplate) {
    await exec(
      `cp ${extractDir}/etc/caddy/Caddyfile.template /etc/caddy/Caddyfile.template`,
    );
  }
  const hasCaddyfile = await fileExists(`${extractDir}/etc/caddy/Caddyfile`);
  if (hasCaddyfile) {
    await exec(`cp ${extractDir}/etc/caddy/Caddyfile /etc/caddy/Caddyfile`);
  }

  const hasConfig = await fileExists(
    `${extractDir}/etc/atelier/${CONFIG_FILE_NAME}`,
  );
  if (hasConfig) {
    await exec(`mkdir -p /etc/atelier`);
    await exec(
      `cp ${extractDir}/etc/atelier/${CONFIG_FILE_NAME} /etc/atelier/${CONFIG_FILE_NAME}`,
    );
  }

  await exec("chown -R atelier:atelier /opt/atelier", { throws: false });
  spinner.stop("Files installed");

  if (hasTemplate && !hasCaddyfile) {
    await renderCaddyConfig();
  }

  spinner.start("Reloading services");
  await exec("systemctl daemon-reload");
  await exec("systemctl enable atelier-network atelier-manager", {
    throws: false,
  });
  await exec("systemctl reload caddy || systemctl start caddy || true", {
    throws: false,
  });
  await exec("systemctl restart atelier-manager");
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

  if (source.type === "local") {
    p.log.success("Server bundle updated from local tarball");
  } else {
    p.log.success(`Server bundle updated to v${CLI_VERSION}`);
  }
}

async function resolveDeploySource(args: string[]): Promise<DeploySource> {
  const localIdx = args.indexOf("--local");
  if (localIdx !== -1) {
    const customPath = args[localIdx + 1];
    const tarballPath =
      customPath && !customPath.startsWith("--")
        ? customPath
        : DEFAULT_LOCAL_TARBALL;

    if (!(await fileExists(tarballPath))) {
      throw new Error(`Local tarball not found: ${tarballPath}`);
    }
    return { type: "local", tarballPath };
  }

  const localExists = await fileExists(DEFAULT_LOCAL_TARBALL);
  if (localExists) {
    const choice = await p.select({
      message: `Local deploy tarball found at ${DEFAULT_LOCAL_TARBALL}`,
      options: [
        {
          value: "local",
          label: "Use local tarball",
          hint: "From scripts/deploy.ts",
        },
        {
          value: "github",
          label: "Download from GitHub",
          hint: `v${CLI_VERSION}`,
        },
      ],
    });

    if (p.isCancel(choice)) {
      p.cancel("Update cancelled");
      process.exit(0);
    }

    if (choice === "local") {
      return { type: "local", tarballPath: DEFAULT_LOCAL_TARBALL };
    }
  }

  const version = CLI_VERSION;
  const repo = process.env.ATELIER_RELEASE_REPO || DEFAULT_REPO;
  const baseUrl =
    process.env.ATELIER_RELEASE_BASE_URL ||
    `https://github.com/${repo}/releases/download/v${version}`;
  const tarballName = `atelier-server-${version}.tar.gz`;

  return {
    type: "github",
    tarballUrl: `${baseUrl}/${tarballName}`,
    checksumsUrl: `${baseUrl}/checksums.txt`,
  };
}

async function renderCaddyConfig() {
  const configPath =
    process.env.ATELIER_CONFIG || `/etc/atelier/${CONFIG_FILE_NAME}`;

  if (!(await fileExists(configPath))) {
    throw new Error(
      `Config file not found: ${configPath}. Run 'atelier config set' or reinstall.`,
    );
  }

  const config = loadConfig({ configFile: configPath });
  const templatePath = "/etc/caddy/Caddyfile.template";
  const template = await Bun.file(templatePath).text();

  const useManualTls =
    config.domain.tls.certPath.trim().length > 0 &&
    config.domain.tls.keyPath.trim().length > 0;

  let output = template
    .replace(/{{SSL_EMAIL}}/g, config.domain.tls.email || "")
    .replace(/{{DASHBOARD_DOMAIN}}/g, config.domain.dashboard)
    .replace(/{{DOMAIN_SUFFIX}}/g, config.domain.baseDomain)
    .replace(/{{MANAGER_PORT}}/g, String(config.server.port));

  if (useManualTls) {
    output = output
      .replace(/{{#MANUAL_TLS}}/g, "")
      .replace(/{{\/MANUAL_TLS}}/g, "")
      .replace(/{{TLS_CERT_PATH}}/g, config.domain.tls.certPath)
      .replace(/{{TLS_KEY_PATH}}/g, config.domain.tls.keyPath)
      .replace(/{{TLS_CONFIG}}/g, "import tls_manual");
  } else {
    output = output.replace(/{{#MANUAL_TLS}}[\s\S]*?{{\/MANUAL_TLS}}\n?/g, "");
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
