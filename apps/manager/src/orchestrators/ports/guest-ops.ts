import type { SandboxConfig } from "@frak/atelier-shared";
import { VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../../infrastructure/agent/index.ts";
import { SecretsService } from "../../infrastructure/secrets/index.ts";
import {
  SharedStorageService,
  StorageService,
} from "../../infrastructure/storage/index.ts";
import type { GitSourceService } from "../../modules/git-source/index.ts";
import type { RepoConfig, Workspace } from "../../schemas/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("guest-ops");

export async function configureDns(
  agent: AgentClient,
  sandboxId: string,
): Promise<void> {
  const dnsServers = config.network.dnsServers;
  const dnsCommands = dnsServers
    .map((dns) => `echo 'nameserver ${dns}' >> /etc/resolv.conf`)
    .join(" && ");

  const cmd = `> /etc/resolv.conf && ${dnsCommands}`;
  const result = await agent.exec(sandboxId, cmd, {
    timeout: 5000,
  });

  if (result.exitCode !== 0) {
    log.warn(
      { sandboxId, exitCode: result.exitCode, stderr: result.stderr },
      "DNS configuration failed",
    );
    throw new Error(`DNS configuration failed: ${result.stderr}`);
  }

  log.debug({ sandboxId }, "DNS configured");
}

export async function syncClock(
  agent: AgentClient,
  sandboxId: string,
): Promise<void> {
  const cmd =
    "pkill chronyd 2>/dev/null; chronyd -f /etc/chrony/chrony.conf 2>/dev/null || true";
  const result = await agent.exec(sandboxId, cmd, {
    timeout: 5000,
  });

  if (result.exitCode !== 0) {
    log.warn(
      { sandboxId, exitCode: result.exitCode, stderr: result.stderr },
      "Clock sync failed (non-blocking)",
    );
  } else {
    log.debug({ sandboxId }, "chronyd started");
  }
}

export async function setHostname(
  agent: AgentClient,
  sandboxId: string,
  hostname: string,
): Promise<void> {
  const cmd = `hostname "${hostname}" && echo "${hostname}" > /etc/hostname`;
  const result = await agent.exec(sandboxId, cmd, {
    timeout: 5000,
  });

  if (result.exitCode !== 0) {
    log.warn(
      { sandboxId, exitCode: result.exitCode, stderr: result.stderr },
      "Failed to set hostname",
    );
  } else {
    log.debug({ sandboxId, hostname }, "Hostname set");
  }
}

export async function pushRuntimeEnv(
  agent: AgentClient,
  sandboxId: string,
  env: Record<string, string>,
): Promise<void> {
  const content = `${Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join("\n")}\n`;

  await agent.writeFiles(sandboxId, [
    {
      path: "/etc/sandbox/runtime.env",
      content,
      mode: "0644",
      owner: "root",
    },
    {
      path: "/etc/profile.d/98-atelier-runtime.sh",
      content:
        "[ -r /etc/sandbox/runtime.env ] && . /etc/sandbox/runtime.env\n",
      owner: "root",
    },
  ]);

  log.debug({ sandboxId, keys: Object.keys(env) }, "Runtime env pushed");
}

export async function pushSandboxConfig(
  agent: AgentClient,
  sandboxId: string,
  sandboxConfig: SandboxConfig,
): Promise<void> {
  await agent.setConfig(sandboxId, sandboxConfig);
  log.debug({ sandboxId }, "Sandbox config pushed via setConfig");
}

export async function pushSecrets(
  agent: AgentClient,
  sandboxId: string,
  envContent: string,
): Promise<void> {
  if (!envContent) return;

  await agent.writeFiles(sandboxId, [
    {
      path: "/etc/sandbox/secrets/.env",
      content: envContent,
      mode: "0600",
      owner: "dev",
    },
    {
      path: "/etc/profile.d/99-sandbox-secrets.sh",
      content:
        '[ "$(id -u)" = "1000" ] && [ -r /etc/sandbox/secrets/.env ] && . /etc/sandbox/secrets/.env\n',
    },
  ]);

  log.debug({ sandboxId }, "Secrets pushed");
}

export async function pushGitConfig(
  agent: AgentClient,
  sandboxId: string,
  credentials: string[],
): Promise<void> {
  const gitconfigSections = [
    "[user]",
    `\temail = ${config.sandbox.git.email}`,
    `\tname = ${config.sandbox.git.name}`,
  ];

  if (credentials.length > 0) {
    gitconfigSections.unshift(
      "[credential]",
      "\thelper = store --file=/etc/sandbox/secrets/git-credentials",
    );
  }

  gitconfigSections.push("");
  const gitconfigContent = gitconfigSections.join("\n");

  const files: Parameters<AgentClient["writeFiles"]>[1] = [
    {
      path: "/etc/gitconfig",
      content: gitconfigContent,
      owner: "root",
    },
  ];

  if (credentials.length > 0) {
    files.push({
      path: "/etc/sandbox/secrets/git-credentials",
      content: `${credentials.join("\n")}\n`,
      mode: "0600",
      owner: "dev",
    });
  }

  await agent.writeFiles(sandboxId, files);
  log.debug(
    { sandboxId, credentialCount: credentials.length },
    "Git config pushed",
  );
}

export async function pushFileSecrets(
  agent: AgentClient,
  sandboxId: string,
  fileSecrets: { path: string; content: string; mode?: string }[],
): Promise<void> {
  if (fileSecrets.length === 0) return;

  const files = fileSecrets.map((secret) => ({
    path: secret.path.replace(/^~/, VM.HOME),
    content: secret.content,
    mode: secret.mode || "0600",
    owner: "dev" as const,
  }));

  await agent.writeFiles(sandboxId, files);
  log.debug({ sandboxId, fileCount: files.length }, "File secrets pushed");
}

export async function pushOhMyOpenCodeCache(
  agent: AgentClient,
  sandboxId: string,
  providers: string[],
): Promise<void> {
  const cacheContent = JSON.stringify(
    {
      connected: providers,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  );

  await agent.writeFiles(sandboxId, [
    {
      path: `${VM.HOME}/.cache/oh-my-opencode/connected-providers.json`,
      content: cacheContent,
      owner: "dev",
    },
  ]);

  log.debug({ sandboxId, providers }, "OhMyOpenCode cache pushed");
}

export async function pushSandboxMd(
  agent: AgentClient,
  sandboxId: string,
  content: string,
): Promise<void> {
  await agent.writeFiles(sandboxId, [
    {
      path: `${VM.HOME}/SANDBOX.md`,
      content,
      owner: "dev",
    },
  ]);

  log.debug({ sandboxId }, "SANDBOX.md pushed");
}

export async function startServices(
  agent: AgentClient,
  sandboxId: string,
  serviceNames: string[],
): Promise<void> {
  await Promise.all(
    serviceNames.map((name) =>
      agent.serviceStart(sandboxId, name).catch((err) => {
        log.warn(
          { sandboxId, service: name, error: String(err) },
          "Service start failed (non-blocking)",
        );
      }),
    ),
  );

  log.info({ sandboxId, services: serviceNames }, "Services started");
}

export async function syncSecrets(
  agent: AgentClient,
  sandboxId: string,
  workspace: Workspace | undefined,
): Promise<void> {
  const secrets = workspace?.config.secrets;
  if (!secrets || Object.keys(secrets).length === 0) return;

  const decrypted = await SecretsService.decryptSecrets(secrets);
  const envFile = SecretsService.generateEnvFile(decrypted);
  await pushSecrets(agent, sandboxId, envFile);
}

export async function syncGitCredentials(
  agent: AgentClient,
  sandboxId: string,
  gitSourceService: GitSourceService,
): Promise<void> {
  const sources = gitSourceService.getAll();
  const credentials: string[] = [];

  for (const source of sources) {
    if (source.type !== "github") continue;

    const accessToken = (source.config as { accessToken?: string }).accessToken;
    if (!accessToken) continue;

    credentials.push(`https://x-access-token:${accessToken}@github.com`);
  }

  await pushGitConfig(agent, sandboxId, credentials);
}

export async function syncFileSecrets(
  agent: AgentClient,
  sandboxId: string,
  workspace: Workspace | undefined,
): Promise<void> {
  const fileSecrets = workspace?.config.fileSecrets;
  if (!fileSecrets || fileSecrets.length === 0) return;

  const decrypted = await SecretsService.decryptFileSecrets(fileSecrets);
  await pushFileSecrets(
    agent,
    sandboxId,
    decrypted.map((secret) => ({
      path: secret.path,
      content: secret.content,
      mode: secret.mode,
    })),
  );
}

export async function buildAuthenticatedGitUrl(
  repo: { sourceId: string; repo: string },
  gitSourceService: GitSourceService,
): Promise<string> {
  const source = gitSourceService.getById(repo.sourceId);
  if (!source) {
    log.warn({ sourceId: repo.sourceId }, "Git source not found");
    return `https://github.com/${repo.repo}.git`;
  }

  if (source.type === "github") {
    const accessToken = (source.config as { accessToken?: string }).accessToken;
    if (accessToken) {
      return `https://x-access-token:${accessToken}@github.com/${repo.repo}.git`;
    }
  }

  return `https://github.com/${repo.repo}.git`;
}

export async function resizeStorage(
  agent: AgentClient,
  sandboxId: string,
): Promise<{
  success: boolean;
  disk?: { total: number; used: number; free: number };
  error?: string;
}> {
  try {
    const result = await agent.exec(
      sandboxId,
      [
        "test -e /dev/vda || mknod /dev/vda b 254 0",
        "resize2fs /dev/vda",
        "df -B1 / | tail -1",
      ].join(" && "),
      { timeout: 60000 },
    );

    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr };
    }

    const lastLine = result.stdout.split("\n").pop() ?? "";
    const [, total, used, free] = lastLine.split(/\s+/);

    return {
      success: true,
      disk: {
        total: parseInt(total || "0", 10),
        used: parseInt(used || "0", 10),
        free: parseInt(free || "0", 10),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function setupSwap(
  agent: AgentClient,
  sandboxId: string,
  useLvm = true,
): Promise<void> {
  if (!useLvm || !(await StorageService.isAvailable())) {
    log.debug({ sandboxId }, "Skipping swap setup (no LVM)");
    return;
  }

  try {
    const result = await agent.exec(sandboxId, "/etc/sandbox/setup-swap.sh", {
      timeout: 30000,
    });

    if (result.exitCode === 0) {
      log.info(
        { sandboxId, output: result.stdout.trim() },
        "Swap setup completed",
      );
    } else {
      log.warn(
        { sandboxId, stderr: result.stderr },
        "Swap setup failed (non-critical)",
      );
    }
  } catch (error) {
    log.warn({ sandboxId, error }, "Swap setup failed (non-critical)");
  }
}

export async function cloneRepository(
  agent: AgentClient,
  sandboxId: string,
  repo: RepoConfig,
  gitSourceService: GitSourceService,
): Promise<void> {
  const clonePath = `${VM.HOME}${repo.clonePath}`;
  const gitUrl =
    "url" in repo
      ? repo.url
      : await buildAuthenticatedGitUrl(repo, gitSourceService);
  const branch = repo.branch;

  log.info({ sandboxId, branch, clonePath }, "Cloning repository");

  await agent.exec(sandboxId, `rm -rf ${clonePath}`);

  const result = await agent.exec(
    sandboxId,
    `git clone --depth 1 -b ${branch} ${gitUrl} ${clonePath}`,
    { timeout: 120000 },
  );

  if (result.exitCode !== 0) {
    log.error({ sandboxId, stderr: result.stderr }, "Git clone failed");
    throw new Error(`Git clone failed: ${result.stderr}`);
  }

  await agent.exec(sandboxId, `chown -R dev:dev ${clonePath}`);
  await agent.exec(
    sandboxId,
    `git config --global --add safe.directory ${clonePath}`,
    { user: "dev" },
  );

  log.info({ sandboxId, clonePath }, "Repository cloned successfully");
}

export async function sanitizeGitRemoteUrls(
  agent: AgentClient,
  sandboxId: string,
  repos: RepoConfig[],
): Promise<void> {
  if (repos.length === 0) return;

  for (const repo of repos) {
    const clonePath = `${VM.HOME}${repo.clonePath}`;
    const result = await agent.exec(
      sandboxId,
      `git -C '${clonePath}' remote get-url origin 2>/dev/null`,
      { timeout: 5000, user: "dev" },
    );

    if (result.exitCode !== 0) continue;

    const currentUrl = result.stdout.trim();
    const cleanUrl = currentUrl.replace(/^(https?:\/\/)[^@]+@/, "$1");

    if (cleanUrl !== currentUrl) {
      await agent.exec(
        sandboxId,
        `git -C '${clonePath}' remote set-url origin '${cleanUrl}'`,
        { timeout: 5000, user: "dev" },
      );

      log.debug({ sandboxId, clonePath }, "Sanitized git remote URL");
    }
  }
}

export async function mountSharedBinaries(
  agent: AgentClient,
  sandboxId: string,
): Promise<void> {
  const imageInfo = await SharedStorageService.getBinariesImageInfo();
  if (!imageInfo.exists) return;

  const mountResult = await agent.exec(
    sandboxId,
    "mountpoint -q /opt/shared || { mknod -m 444 /dev/vdb b 254 16 2>/dev/null; mkdir -p /opt/shared && mount -o ro /dev/vdb /opt/shared; }",
    { timeout: 5000 },
  );

  if (mountResult.exitCode === 0) {
    log.info({ sandboxId }, "Shared binaries mounted");
  } else {
    log.warn(
      { sandboxId, stderr: mountResult.stderr },
      "Failed to mount shared binaries",
    );
  }
}
