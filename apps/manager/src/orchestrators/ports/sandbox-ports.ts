import type { AgentClient } from "../../infrastructure/agent/index.ts";
import type { ConfigFileService } from "../../modules/config-file/index.ts";
import type { GitSourceService } from "../../modules/git-source/index.ts";
import type { InternalService } from "../../modules/internal/index.ts";
import type { SandboxRepository } from "../../modules/sandbox/index.ts";
import type { SshKeyService } from "../../modules/ssh-key/index.ts";
import type { WorkspaceService } from "../../modules/workspace/index.ts";

export interface SandboxPorts {
  agent: AgentClient;
  sandbox: SandboxRepository;
  workspaces: WorkspaceService;
  gitSources: GitSourceService;
  configFiles: ConfigFileService;
  sshKeys: SshKeyService;
  internal: InternalService;
}
