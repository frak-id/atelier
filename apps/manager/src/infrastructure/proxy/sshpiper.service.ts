import * as yaml from "yaml";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("sshpiper");

interface SshPipeFrom {
  username: string;
  username_regex_match?: boolean;
}

interface SshPipe {
  from: SshPipeFrom[];
  to: {
    host: string;
    username: string;
    ignore_hostkey?: boolean;
    private_key?: string;
  };
}

interface PipesConfig {
  version: string;
  pipes: SshPipe[];
}

async function readPipesConfig(): Promise<PipesConfig> {
  try {
    const content = await Bun.file(config.sshProxy.pipesFile).text();
    return yaml.parse(content) as PipesConfig;
  } catch {
    return { version: "1.0", pipes: [] };
  }
}

async function writePipesConfig(pipesConfig: PipesConfig): Promise<void> {
  const content = yaml.stringify(pipesConfig, { lineWidth: 0 });
  await Bun.write(config.sshProxy.pipesFile, content);
}

export const SshPiperService = {
  async registerRoute(sandboxId: string, ipAddress: string): Promise<string> {
    if (config.isMock()) {
      log.debug({ sandboxId, ipAddress }, "Mock: SSH route registered");
      return `ssh ${sandboxId}@${config.sshProxy.domain} -p ${config.sshProxy.port}`;
    }

    const pipesConfig = await readPipesConfig();

    const existingIndex = pipesConfig.pipes.findIndex((p) =>
      p.from.some((f) => f.username === sandboxId),
    );
    if (existingIndex >= 0) {
      pipesConfig.pipes.splice(existingIndex, 1);
    }

    pipesConfig.pipes.push({
      from: [{ username: sandboxId }],
      to: {
        host: `${ipAddress}:22`,
        username: "root",
        ignore_hostkey: true,
        private_key: "/var/lib/sandbox/firecracker/rootfs/vm-ssh-key",
      },
    });

    await writePipesConfig(pipesConfig);
    log.info({ sandboxId, ipAddress }, "SSH route registered");

    return `ssh ${sandboxId}@${config.sshProxy.domain} -p ${config.sshProxy.port}`;
  },

  async removeRoute(sandboxId: string): Promise<void> {
    if (config.isMock()) {
      log.debug({ sandboxId }, "Mock: SSH route removed");
      return;
    }

    const pipesConfig = await readPipesConfig();

    const existingIndex = pipesConfig.pipes.findIndex((p) =>
      p.from.some((f) => f.username === sandboxId),
    );

    if (existingIndex >= 0) {
      pipesConfig.pipes.splice(existingIndex, 1);
      await writePipesConfig(pipesConfig);
      log.info({ sandboxId }, "SSH route removed");
    }
  },

  async getRoutes(): Promise<SshPipe[]> {
    if (config.isMock()) {
      return [];
    }

    const pipesConfig = await readPipesConfig();
    return pipesConfig.pipes;
  },

  async isHealthy(): Promise<boolean> {
    if (config.isMock()) {
      return true;
    }

    try {
      await Bun.file(config.sshProxy.pipesFile).text();
      return true;
    } catch {
      return false;
    }
  },

  getSshCommand(sandboxId: string): string {
    if (config.sshProxy.port === 22) {
      return `ssh ${sandboxId}@${config.sshProxy.domain}`;
    }
    return `ssh ${sandboxId}@${config.sshProxy.domain} -p ${config.sshProxy.port}`;
  },

  getVscodeCommand(sandboxId: string): string {
    const sshHost =
      config.sshProxy.port === 22
        ? `${sandboxId}@${config.sshProxy.domain}`
        : `${sandboxId}@${config.sshProxy.domain}:${config.sshProxy.port}`;
    return `code --remote ssh-remote+${sshHost} /workspace`;
  },
};
