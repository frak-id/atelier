import type { SandboxConfig } from "@frak/atelier-shared";
import { VM } from "@frak/atelier-shared/constants";
import type { Workspace } from "../schemas/index.ts";
import { config } from "../shared/lib/config.ts";

/**
 * Workspace-mode flags forwarded from the local opencode-atelier plugin.
 *
 * These come from upstream OpenCode's `WorkspaceAdapter.create(info, env, from?)`
 * env arg plus our own preregistration metadata. They get merged into the
 * `opencode serve` env block so the remote opencode boots in workspace mode
 * and our preregister plugin can alias the local project_id into the
 * remote `project` table before `/sync/replay` arrives.
 */
export interface OpencodeWorkspaceContext {
  /** Filtered env from `WorkspaceAdapter.create(info, env)`'s second arg. */
  opencodeEnv?: Record<string, string>;
  /** Local OpenCode project_id — row to alias on the remote. */
  sourceProjectID?: string;
  /** Local OpenCode workspace_id — informational. */
  sourceWorkspaceID?: string;
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

  const workspaceDir =
    repos.length === 1 && repos[0]?.clonePath
      ? `${VM.HOME}${repos[0].clonePath.startsWith("/workspace") ? repos[0].clonePath : `/workspace${repos[0].clonePath}`}`
      : VM.WORKSPACE_DIR;

  const dashboardDomain = config.domain.dashboard;
  const vsPort = config.ports.vscode;
  const ocPort = config.ports.opencode;
  const browserPort = config.ports.browser;
  const terminalPort = config.ports.terminal;

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
    services: {
      vscode: {
        port: vsPort,
        command: `/opt/shared/bin/code-server --bind-addr 0.0.0.0:${vsPort} --auth none --disable-telemetry ${workspaceDir}`,
        user: "dev" as const,
        autoStart: true,
      },
      opencode: {
        port: ocPort,
        command: `cd ${workspaceDir} && /opt/shared/bin/opencode serve --hostname 0.0.0.0 --port ${ocPort} --cors https://${dashboardDomain}`,
        user: "dev" as const,
        autoStart: true,
        env: {
          ...(opencodePassword && {
            OPENCODE_SERVER_PASSWORD: opencodePassword,
          }),
          // Forwarded from the local opencode-atelier plugin. Anything
          // missing on this side leaves the remote opencode in
          // non-workspace mode, which is fine for plain VSCode use but
          // breaks `/sync/replay` because workspace events have nowhere
          // to land.
          ...(workspaceContext?.opencodeEnv ?? {}),
        },
      },
      terminal: {
        port: terminalPort,
        enabled: true,
      },
      kasmvnc: {
        port: browserPort,
        command: `Xvnc :99 -geometry 1280x900 -depth 24 -websocketPort ${browserPort} -SecurityTypes None -AlwaysShared -AcceptSetDesktopSize -DisableBasicAuth -UseIPv6 0 -interface 0.0.0.0 -httpd /usr/share/kasmvnc/www -FrameRate 60 -DynamicQualityMin 7 -DynamicQualityMax 9 -RectThreads 0 -CompareFB 2 -DetectScrolling -sslOnly 0`,
        user: "root" as const,
        autoStart: false,
      },
      openbox: {
        command: "openbox",
        user: "dev" as const,
        autoStart: false,
        env: { DISPLAY: ":99" },
      },
      chromium: {
        command:
          "chromium --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage --no-first-run --disable-session-crashed-bubble --disable-infobars --disable-translate --disable-features=TranslateUI --password-store=basic --disable-background-networking --disable-sync --disable-extensions --disable-default-apps --disable-breakpad --disable-component-extensions-with-background-pages --disable-background-timer-throttling --force-device-scale-factor=1 --disable-lcd-text --renderer-process-limit=2 --disk-cache-size=104857600 --user-data-dir=/tmp/chromium-profile about:blank",
        user: "dev" as const,
        autoStart: false,
        env: { DISPLAY: ":99" },
      },
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
