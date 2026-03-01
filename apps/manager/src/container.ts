import { AgentClient, AgentOperations } from "./infrastructure/agent/index.ts";
import { KubeClient } from "./infrastructure/kubernetes/index.ts";
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
import { SandboxRepository } from "./modules/sandbox/index.ts";
import { SessionTemplateService } from "./modules/session-template/index.ts";
import { SshKeyRepository, SshKeyService } from "./modules/ssh-key/index.ts";
import {
  SystemAiService,
  SystemSandboxEventListener,
  SystemSandboxService,
} from "./modules/system-sandbox/index.ts";
import { TaskRepository, TaskService } from "./modules/task/index.ts";
import {
  WorkspaceRepository,
  WorkspaceService,
} from "./modules/workspace/index.ts";
import {
  PrebuildChecker,
  PrebuildRunner,
  SandboxDestroyer,
  SandboxLifecycle,
  SandboxSpawner,
  TaskSpawner,
} from "./orchestrators/index.ts";
import type { SandboxPorts } from "./orchestrators/ports/sandbox-ports.ts";
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
);

const agentOperations = new AgentOperations(agentClient);

const sandboxPorts: SandboxPorts = {
  agent: agentClient,
  sandbox: sandboxService,
  workspaces: workspaceService,
  gitSources: gitSourceService,
  configFiles: configFileService,
  sshKeys: sshKeyService,
  internal: internalService,
};

const sessionTemplateService = new SessionTemplateService(
  configFileService,
  workspaceService,
  sandboxService,
);

/* -------------------------------------------------------------------------- */
/*                                Orchestrators                               */
/* -------------------------------------------------------------------------- */

const sandboxSpawner = new SandboxSpawner(sandboxPorts);

const sandboxDestroyer = new SandboxDestroyer({
  sandboxService,
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
  configFileService,
);
const taskService = new TaskService(taskRepository);

const sandboxLifecycle = new SandboxLifecycle(sandboxPorts);
const kubeClient = new KubeClient();

const prebuildRunner = new PrebuildRunner({
  workspaceService,
  gitSourceService,
  kubeClient,
  aiService: systemAiService,
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
  gitSourceService,
  prebuildRunner,
});

export {
  agentClient,
  agentOperations,
  authSyncService,
  configFileService,
  gitSourceService,
  internalService,
  prebuildChecker,
  prebuildRunner,
  sandboxDestroyer,
  sandboxLifecycle,
  sandboxService,
  sandboxSpawner,
  integrationEventBridge,
  integrationGateway,
  slackAdapter,
  sshKeyService,
  systemAiService,
  systemSandboxEventListener,
  systemSandboxService,
  taskService,
  taskSpawner,
  sessionTemplateService,
  workspaceService,
};
