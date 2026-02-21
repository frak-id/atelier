import { AgentClient, AgentOperations } from "./infrastructure/agent/index.ts";
import {
  ConfigFileRepository,
  ConfigFileService,
} from "./modules/config-file/index.ts";
import {
  GitSourceRepository,
  GitSourceService,
} from "./modules/git-source/index.ts";
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
  SandboxProvisionService,
  SandboxRepository,
} from "./modules/sandbox/index.ts";
import { SessionTemplateService } from "./modules/session-template/index.ts";
import { SshKeyRepository, SshKeyService } from "./modules/ssh-key/index.ts";
import { SystemSandboxService } from "./modules/system-sandbox/index.ts";
import { TaskRepository, TaskService } from "./modules/task/index.ts";
import { TitleService } from "./modules/title/index.ts";
import {
  WorkspaceRepository,
  WorkspaceService,
} from "./modules/workspace/index.ts";
import {
  PrebuildChecker,
  SandboxDestroyer,
  SandboxLifecycle,
  SandboxSpawner,
  SystemPrebuildRunner,
  TaskSpawner,
  WorkspacePrebuildRunner,
} from "./orchestrators/index.ts";
import { config } from "./shared/lib/config.ts";

/* -------------------------------------------------------------------------- */
/*                                Repositories                                */
/* -------------------------------------------------------------------------- */

const configFileRepository = new ConfigFileRepository();
const gitSourceRepository = new GitSourceRepository();
const sshKeyRepository = new SshKeyRepository();
const taskRepository = new TaskRepository();
const workspaceRepository = new WorkspaceRepository();
const sandboxRepository = new SandboxRepository();
const sharedAuthRepository = new SharedAuthRepository();

/* -------------------------------------------------------------------------- */
/*                                  Services                                  */
/* -------------------------------------------------------------------------- */

const configFileService = new ConfigFileService(configFileRepository);
const gitSourceService = new GitSourceService(gitSourceRepository);
const sshKeyService = new SshKeyService(sshKeyRepository);
const workspaceService = new WorkspaceService(workspaceRepository);
const sandboxService = sandboxRepository;

const agentClient = new AgentClient();
const sandboxProvisionService = new SandboxProvisionService(agentClient);

const authSyncService = new AuthSyncService(
  sharedAuthRepository,
  agentClient,
  sandboxService,
);

const internalService = new InternalService(
  authSyncService,
  configFileService,
  agentClient,
  sandboxService,
  sandboxProvisionService,
);

const agentOperations = new AgentOperations(agentClient);

const sessionTemplateService = new SessionTemplateService(
  configFileService,
  workspaceService,
  sandboxService,
);

/* -------------------------------------------------------------------------- */
/*                                Orchestrators                               */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*                             System Sandbox + AI                            */
/* -------------------------------------------------------------------------- */

const sandboxSpawner = new SandboxSpawner({
  sandboxService,
  workspaceService,
  gitSourceService,
  configFileService,
  sshKeyService,
  internalService,
  provisionService: sandboxProvisionService,
  agentClient,
  agentOperations,
});

const sandboxDestroyer = new SandboxDestroyer({
  sandboxService,
});

const systemSandboxService = new SystemSandboxService({
  sandboxSpawner,
  sandboxDestroyer,
  sandboxService,
  internalService,
});

const titleService = new TitleService(systemSandboxService);
const taskService = new TaskService(taskRepository);

const sandboxLifecycle = new SandboxLifecycle({
  sandboxService,
  agentClient,
  internalService,
  provisionService: sandboxProvisionService,
  workspaceService,
  gitSourceService,
  configFileService,
});

const workspacePrebuildRunner = new WorkspacePrebuildRunner({
  sandboxSpawner,
  sandboxDestroyer,
  sandboxService,
  workspaceService,
  agentClient,
  internalService,
});

const systemPrebuildRunner = new SystemPrebuildRunner({
  sandboxSpawner,
  sandboxDestroyer,
  sandboxService,
  agentClient,
  internalService,
});

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
  workspaceService,
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
  gitSourceService,
  prebuildRunner: workspacePrebuildRunner,
});

export {
  agentClient,
  agentOperations,
  authSyncService,
  configFileService,
  gitSourceService,
  internalService,
  prebuildChecker,
  workspacePrebuildRunner as prebuildRunner,
  systemPrebuildRunner,
  sandboxDestroyer,
  sandboxLifecycle,
  sandboxService,
  sandboxSpawner,
  integrationEventBridge,
  integrationGateway,
  slackAdapter,
  sshKeyService,
  systemSandboxService,
  taskService,
  taskSpawner,
  titleService,
  sessionTemplateService,
  workspaceService,
};
