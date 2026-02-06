import { SSH_PROXY } from "@frak/atelier-shared/constants";
import * as yaml from "yaml";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("sshpiper");

interface SshPipeFrom {
  username: string;
  username_regex_match?: boolean;
  authorized_keys_data?: string;
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

function encodeAuthorizedKeys(publicKeys: string[]): string | undefined {
  if (publicKeys.length === 0) return undefined;
  const authorizedKeys = publicKeys.map((k) => k.trim()).join("\n");
  return Buffer.from(authorizedKeys).toString("base64");
}

async function readPipesConfig(): Promise<PipesConfig> {
  try {
    const content = await Bun.file(SSH_PROXY.PIPES_FILE).text();
    return yaml.parse(content) as PipesConfig;
  } catch {
    return { version: "1.0", pipes: [] };
  }
}

async function writePipesConfig(pipesConfig: PipesConfig): Promise<void> {
  const content = yaml.stringify(pipesConfig, { lineWidth: 0 });
  await Bun.write(SSH_PROXY.PIPES_FILE, content);
}

export const SshPiperService = {
  async registerRoute(
    sandboxId: string,
    ipAddress: string,
    publicKeys: string[] = [],
  ): Promise<string> {
    if (config.isMock()) {
      log.debug({ sandboxId, ipAddress }, "Mock: SSH route registered");
      return `ssh ${sandboxId}@${config.sshProxy.domain} -p ${config.sshProxy.port}`;
    }

    const pipesConfig = await readPipesConfig();
    const authorizedKeysData = encodeAuthorizedKeys(publicKeys);

    const existingIndex = pipesConfig.pipes.findIndex((p) =>
      p.from.some((f) => f.username === sandboxId),
    );
    if (existingIndex >= 0) {
      pipesConfig.pipes.splice(existingIndex, 1);
    }

    const fromEntry: SshPipeFrom = { username: sandboxId };
    if (authorizedKeysData) {
      fromEntry.authorized_keys_data = authorizedKeysData;
    }

    pipesConfig.pipes.push({
      from: [fromEntry],
      to: {
        host: `${ipAddress}:22`,
        username: "dev",
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

  async listRouteSandboxIds(): Promise<string[]> {
    if (config.isMock()) return [];

    const pipesConfig = await readPipesConfig();
    return pipesConfig.pipes.flatMap((p) => p.from.map((f) => f.username));
  },

  async updateAuthorizedKeys(publicKeys: string[]): Promise<void> {
    if (config.isMock()) {
      log.debug(
        { keyCount: publicKeys.length },
        "Mock: Updating authorized keys",
      );
      return;
    }

    const pipesConfig = await readPipesConfig();
    const authorizedKeysData = encodeAuthorizedKeys(publicKeys);

    for (const pipe of pipesConfig.pipes) {
      for (const from of pipe.from) {
        if (authorizedKeysData) {
          from.authorized_keys_data = authorizedKeysData;
        } else {
          delete from.authorized_keys_data;
        }
      }
    }

    await writePipesConfig(pipesConfig);
    log.info(
      { pipeCount: pipesConfig.pipes.length, keyCount: publicKeys.length },
      "SSH authorized keys updated",
    );
  },
};
