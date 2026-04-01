import { AgentClient, AgentOperations } from "./infrastructure/agent/index.ts";
import { kubeClient } from "./infrastructure/kubernetes/index.ts";
import { ApiKeyRepository, ApiKeyService } from "./modules/api-key/index.ts";
import { CLIProxyService } from "./modules/cliproxy/index.ts";
import {
  ConfigFileRepository,
  ConfigFileService,
} from "./modules/config-file/index.ts";
import {
  IntegrationEventBridge,
  IntegrationGateway,
  SlackAdapter,
} from "./modules/integration/index.ts";
import {
  AuthSyncService,
  InternalService,
  SharedAuthRepository,
} from "./modules/internal/index.ts";
import {
  OrgMemberRepository,
  OrgMemberService,
} from "./modules/org-member/index.ts";
import {
  OrganizationRepository,
  OrganizationService,
} from "./modules/organization/index.ts";
import { SandboxRepository } from "./modules/sandbox/index.ts";
import { SessionTemplateService } from "./modules/session-template/index.ts";
import { SettingsRepository } from "./modules/settings/index.ts";
import { SshKeyRepository, SshKeyService } from "./modules/ssh-key/index.ts";
import {
  SystemAiService,
  SystemSandboxEventListener,
  SystemSandboxService,
} from "./modules/system-sandbox/index.ts";
import { TaskRepository, TaskService } from "./modules/task/index.ts";
import { UserRepository, UserService } from "./modules/user/index.ts";
import {
  WorkspaceRepository,
  WorkspaceService,
} from "./modules/workspace/index.ts";
import {
  BaseImageBuilder,
  PrebuildChecker,
  PrebuildRunner,
  SandboxDestroyer,
  SandboxLifecycle,
  SandboxSpawner,
  TaskSpawner,
} from "./orchestrators/index.ts";
import type { SandboxPorts } from "./orchestrators/ports/sandbox-ports.ts";
import { initAuthDependencies } from "./shared/lib/auth.ts";
import { config } from "./shared/lib/config.ts";

/* -------------------------------------------------------------------------- */
/*                                Repositories                                */
/* -------------------------------------------------------------------------- */

const configFileRepository = new ConfigFileRepository();
const organizationRepository = new OrganizationRepository();
const orgMemberRepository = new OrgMemberRepository();
const settingsRepository = new SettingsRepository();
const sshKeyRepository = new SshKeyRepository();
const taskRepository = new TaskRepository();
const userRepository = new UserRepository();
const workspaceRepository = new WorkspaceRepository();
const sandboxRepository = new SandboxRepository();
const sharedAuthRepository = new SharedAuthRepository();
const apiKeyRepository = new ApiKeyRepository();

/* -------------------------------------------------------------------------- */
/*                                  Services                                  */
/* -------------------------------------------------------------------------- */

const configFileService = new ConfigFileService(configFileRepository);
const organizationService = new OrganizationService(organizationRepository);
const orgMemberService = new OrgMemberService(
  orgMemberRepository,
  userRepository,
);
const sshKeyService = new SshKeyService(sshKeyRepository);
const userService = new UserService(userRepository);
const apiKeyService = new ApiKeyService(apiKeyRepository);
initAuthDependencies({ apiKeyService, userService });
const workspaceService = new WorkspaceService(workspaceRepository);
const sandboxService = sandboxRepository;

const agentClient = new AgentClient();

const authSyncService = new AuthSyncService(
  sharedAuthRepository,
  agentClient,
  sandboxService,
);

const internalService = new InternalService(
  authSyncService,
  configFileService,
  settingsRepository,
  agentClient,
  sandboxService,
);

const agentOperations = new AgentOperations(agentClient);

const cliProxyService = new CLIProxyService(
  settingsRepository,
  internalService,
);
internalService.setCliProxyService(cliProxyService);

const sandboxPorts: SandboxPorts = {
  agent: agentClient,
  sandbox: sandboxService,
  workspaces: workspaceService,
  users: userService,
  configFiles: configFileService,
  sshKeys: sshKeyService,
  internal: internalService,
  cliproxy: cliProxyService,
};

const sessionTemplateService = new SessionTemplateService(
  settingsRepository,
  workspaceService,
  sandboxService,
);

/* -------------------------------------------------------------------------- */
/*                                Orchestrators                               */
/* -------------------------------------------------------------------------- */

const sandboxSpawner = new SandboxSpawner(sandboxPorts);

const sandboxDestroyer = new SandboxDestroyer({
  sandboxService,
  cliProxyService,
});

const systemSandboxEventListener = new SystemSandboxEventListener({
  sandboxService,
});

const systemSandboxService = new SystemSandboxService({
  sandboxSpawner,
  sandboxDestroyer,
  sandboxService,
  internalService,
  eventListener: systemSandboxEventListener,
});

const systemAiService = new SystemAiService(
  systemSandboxService,
  settingsRepository,
);
const taskService = new TaskService(taskRepository);

const sandboxLifecycle = new SandboxLifecycle(sandboxPorts);

const prebuildRunner = new PrebuildRunner({
  workspaceService,
  userService,
  kubeClient,
  agentClient,
  aiService: systemAiService,
});

const baseImageBuilder = new BaseImageBuilder(kubeClient);

const taskSpawner = new TaskSpawner({
  sandboxSpawner,
  sandboxService,
  taskService,
  workspaceService,
  sessionTemplateService,
  agentClient,
});

const slackAdapter = config.integrations.slack.enabled
  ? new SlackAdapter()
  : null;

const integrationGateway = new IntegrationGateway({
  taskService,
  sandboxService,
  sandboxLifecycle,
  systemSandboxService,
  systemSandboxEventListener,
  workspaceService,
  systemAiService,
  taskSpawner,
  agentClient,
  sessionTemplateService,
});
if (slackAdapter) {
  integrationGateway.registerAdapter(slackAdapter);
}

const integrationEventBridge = new IntegrationEventBridge({
  taskService,
  sandboxService,
  integrationGateway,
});

const prebuildChecker = new PrebuildChecker({
  workspaceService,
  userService,
  prebuildRunner,
});

export {
  agentClient,
  apiKeyService,
  agentOperations,
  authSyncService,
  baseImageBuilder,
  cliProxyService,
  configFileService,
  integrationEventBridge,
  integrationGateway,
  internalService,
  kubeClient,
  orgMemberService,
  organizationService,
  prebuildChecker,
  prebuildRunner,
  sandboxDestroyer,
  sandboxLifecycle,
  sandboxService,
  sandboxSpawner,
  sessionTemplateService,
  slackAdapter,
  sshKeyService,
  systemAiService,
  systemSandboxEventListener,
  systemSandboxService,
  taskService,
  taskSpawner,
  userService,
  workspaceService,
};
