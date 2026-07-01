import type { SandboxConfig } from "@frak/atelier-shared";
import { VM } from "@frak/atelier-shared/constants";
import { resolveDevConfig, type Workspace } from "../schemas/index.ts";
import { config } from "../shared/lib/config.ts";
import { buildToolServices } from "./tools/registry.ts";

/**
 * Workspace-mode context forwarded from the local harness plugin (today
 * opencode-atelier). Merged into the agent's env block so the remote harness
 * boots in workspace mode (e.g. `OPENCODE_EXPERIMENTAL_WORKSPACES` +
 * `OPENCODE_WORKSPACE_ID` for opencode).
 */
export interface AgentWorkspaceContext {
  /** Filtered env from `WorkspaceAdapter.create(info, env)`'s second arg. */
  agentEnv?: Record<string, string>;
  /** Origin workspace_id when forking. */
  sourceWorkspaceFromID?: string;
}

export function buildSandboxConfig(
  sandboxId: string,
  workspace: Workspace | undefined,
  agentPassword: string | undefined,
  workspaceContext?: AgentWorkspaceContext,
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
      agentPassword,
      agentEnv: workspaceContext?.agentEnv,
      dev: resolveDevConfig(workspace?.config),
    }),
    devForwarder: {
      publicPort: config.ports.dev,
      appPort: config.ports.devApp,
    },
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

  const dev = resolveDevConfig(ws?.config);
  const devCommandsSection = dev
    ? `- \`${dev.command}\`${dev.workdir ? ` (workdir: \`${dev.workdir}\`)` : ""}`
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

## Dev Server
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
