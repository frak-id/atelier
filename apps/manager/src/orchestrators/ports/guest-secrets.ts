import { VM } from "@frak/atelier-shared/constants";
import type { FileWrite } from "../../infrastructure/agent/agent.types.ts";
import { SecretsService } from "../../infrastructure/secrets/index.ts";
import type { GitSourceService } from "../../modules/git-source/index.ts";
import type { Workspace } from "../../schemas/index.ts";
import { config } from "../../shared/lib/config.ts";

// --- Pure file builders ---

export function buildSecretFiles(envContent: string): FileWrite[] {
  if (!envContent) return [];
  return [
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
  ];
}

export interface GitUserIdentity {
  name: string;
  email: string;
}

export function buildGitConfigFiles(
  credentials: string[],
  userIdentity?: GitUserIdentity,
): FileWrite[] {
  const gitName = userIdentity?.name ?? config.sandbox.git.name;
  const gitEmail = userIdentity?.email ?? config.sandbox.git.email;

  const sections = ["[user]", `\temail = ${gitEmail}`, `\tname = ${gitName}`];
  if (credentials.length > 0) {
    sections.unshift(
      "[credential]",
      "\thelper = store --file=/etc/sandbox/secrets/git-credentials",
    );
  }
  if (userIdentity) {
    sections.push("[commit]", "\ttemplate = /etc/sandbox/git-commit-template");
  }
  sections.push("");

  const files: FileWrite[] = [
    {
      path: "/etc/gitconfig",
      content: sections.join("\n"),
      owner: "root",
    },
  ];

  if (userIdentity) {
    const coAuthorTrailer = `\n\nCo-authored-by: ${config.sandbox.git.name} <${config.sandbox.git.email}>\n`;
    files.push({
      path: "/etc/sandbox/git-commit-template",
      content: coAuthorTrailer,
      owner: "root",
    });
  }

  if (credentials.length > 0) {
    files.push({
      path: "/etc/sandbox/secrets/git-credentials",
      content: `${credentials.join("\n")}\n`,
      mode: "0600",
      owner: "dev",
    });
  }
  return files;
}

export function buildFileSecretFiles(
  fileSecrets: { path: string; content: string; mode?: string }[],
): FileWrite[] {
  if (fileSecrets.length === 0) return [];
  return fileSecrets.map((s) => ({
    path: s.path.replace(/^~/, VM.HOME),
    content: s.content,
    mode: s.mode || "0600",
    owner: "dev" as const,
  }));
}

// --- Async collectors (prep + build) ---

export async function collectSecretFiles(
  workspace: Workspace | undefined,
): Promise<FileWrite[]> {
  const secrets = workspace?.config.secrets;
  if (!secrets || Object.keys(secrets).length === 0) return [];
  const decrypted = await SecretsService.decryptSecrets(secrets);
  const envFile = SecretsService.generateEnvFile(decrypted);
  return buildSecretFiles(envFile);
}

export async function collectGitCredentialFiles(
  gitSourceService: GitSourceService,
  userIdentity?: GitUserIdentity,
): Promise<FileWrite[]> {
  const sources = gitSourceService.getAll();
  const credentials: string[] = [];
  for (const source of sources) {
    if (source.type !== "github") continue;
    const token = (source.config as { accessToken?: string }).accessToken;
    if (token) {
      credentials.push(`https://x-access-token:${token}@github.com`);
    }
  }
  return buildGitConfigFiles(credentials, userIdentity);
}

export async function collectFileSecretFiles(
  workspace: Workspace | undefined,
): Promise<FileWrite[]> {
  const fileSecrets = workspace?.config.fileSecrets;
  if (!fileSecrets || fileSecrets.length === 0) return [];
  const decrypted = await SecretsService.decryptFileSecrets(fileSecrets);
  return buildFileSecretFiles(
    decrypted.map((s) => ({
      path: s.path,
      content: s.content,
      mode: s.mode,
    })),
  );
}
