import type { SandboxConfig } from "@frak/atelier-shared";
import { VM } from "@frak/atelier-shared/constants";
import type { Workspace } from "../schemas/index.ts";
import { config } from "../shared/lib/config.ts";
import { buildToolServices } from "./tools/registry.ts";

/**
 * Workspace-mode context forwarded from the local opencode-atelier plugin.
 * Merged into the `opencode serve` env block so the remote opencode boots
 * in workspace mode (`OPENCODE_EXPERIMENTAL_WORKSPACES` + `OPENCODE_WORKSPACE_ID`).
 */
export interface OpencodeWorkspaceContext {
  /** Filtered env from `WorkspaceAdapter.create(info, env)`'s second arg. */
  opencodeEnv?: Record<string, string>;
  /** Origin workspace_id when forking. */
  sourceWorkspaceFromID?: string;
}

export function buildSandboxConfig(
  sandboxId: string,
  workspace: Workspace | undefined,
  opencodePassword: string | undefined,
  workspaceContext?: OpencodeWorkspaceContext,
): SandboxConfig {
  const repos = (workspace?.config.repos ?? []).map((r) => ({
    clonePath: r.clonePath,
    branch: r.branch,
  }));

  const workspaceDir = resolveWorkspaceDir(workspace);

  const dashboardDomain = config.domain.dashboard;

  return {
    sandboxId,
    workspaceId: workspace?.id,
    workspaceName: workspace?.name,
    repos,
    createdAt: new Date().toISOString(),
    network: {
      dashboardDomain,
      managerInternalUrl: `${config.kubernetes.managerUrl}/internal`,
    },
    services: buildToolServices({
      workspaceDir,
      dashboardDomain,
      opencodePassword,
      opencodeEnv: workspaceContext?.opencodeEnv,
    }),
  };
}

export function generateSandboxMd(
  sandboxId: string,
  workspace: Workspace | undefined,
): string {
  const ws = workspace;
  const reposSection = ws?.config.repos.length
    ? ws.config.repos
        .map((r) => {
          return `- **${r.url}** (branch: \`${r.branch}\`, path: \`${VM.HOME}${r.clonePath}\`)`;
        })
        .join("\n")
    : "No repositories configured";

  const vsPort = config.ports.vscode;
  const ocPort = config.ports.opencode;

  const devCommandsSection = ws?.config.devCommands?.length
    ? ws.config.devCommands
        .map((cmd) => {
          const parts = [`\`${cmd.command}\``];
          if (cmd.workdir) parts.push(`workdir: \`${cmd.workdir}\``);
          if (cmd.port) parts.push(`port: ${cmd.port}`);
          return `- **${cmd.name}**: ${parts.join(", ")}`;
        })
        .join("\n")
    : "None configured";

  const secretsSection =
    ws?.config.secrets && Object.keys(ws.config.secrets).length > 0
      ? `Available in \`/etc/sandbox/secrets/.env\` (source with: \`source /etc/sandbox/secrets/.env\`)\nKeys: ${Object.keys(ws.config.secrets).join(", ")}`
      : "None configured";

  const fileSecretsSection = ws?.config.fileSecrets?.length
    ? ws.config.fileSecrets
        .map((s) => `- **${s.name}**: \`${s.path.replace(/^~/, VM.HOME)}\``)
        .join("\n")
    : "";

  return `# Sandbox: ${sandboxId}${ws ? ` (${ws.name})` : ""}

## Repositories
${reposSection}

## Services
| Service | Port | Logs |
|---------|------|------|
| code-server (VSCode) | ${vsPort} | \`/var/log/sandbox/vscode.log\` |
| opencode | ${ocPort} | \`/var/log/sandbox/opencode.log\` |
| sshd | 22 | — |

## Dev Commands
${devCommandsSection}

## Environment Secrets
${secretsSection}
${fileSecretsSection ? `\n## File Secrets\n${fileSecretsSection}` : ""}
## Paths
- Workspace: \`${VM.WORKSPACE_DIR}\`
- Config: \`/etc/sandbox/config.json\`
- Logs: \`/var/log/sandbox/\`
`;
}

/**
 * Mirrors the path the remote `opencode serve` actually `cd`s into before
 * starting (single-repo → `${HOME}<clonePath>`, else `WORKSPACE_DIR`).
 */
export function resolveWorkspaceDir(workspace: Workspace | undefined): string {
  const clonePath = workspace?.config.repos?.[0]?.clonePath;
  if (workspace?.config.repos?.length === 1 && clonePath) {
    const suffix = clonePath.startsWith("/workspace")
      ? clonePath
      : `/workspace${clonePath}`;
    return `${VM.HOME}${suffix}`;
  }
  return VM.WORKSPACE_DIR;
}
