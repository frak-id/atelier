import { VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../../infrastructure/agent/index.ts";
import { SecretsService } from "../../infrastructure/secrets/index.ts";
import type { GitSourceService } from "../../modules/git-source/index.ts";
import type { Workspace } from "../../schemas/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("guest-secrets");

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
