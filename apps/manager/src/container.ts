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
  InternalService,
  SharedAuthRepository,
} from "./modules/internal/index.ts";
import { SandboxRepository, SandboxService } from "./modules/sandbox/index.ts";
import { SessionTemplateService } from "./modules/session-template/index.ts";
import { SshKeyRepository, SshKeyService } from "./modules/ssh-key/index.ts";
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
const taskService = new TaskService(taskRepository);
const workspaceService = new WorkspaceService(workspaceRepository);
const sandboxService = new SandboxService(sandboxRepository);
const internalService = new InternalService(
  sharedAuthRepository,
  configFileService,
);

const agentClient = new AgentClient();
const agentOperations = new AgentOperations(agentClient);

const sessionTemplateService = new SessionTemplateService(
  configFileService,
  workspaceService,
  sandboxService,
);

/* -------------------------------------------------------------------------- */
/*                                Orchestrators                               */
/* -------------------------------------------------------------------------- */

const sandboxSpawner = new SandboxSpawner({
  sandboxService,
  workspaceService,
  gitSourceService,
  configFileService,
  sshKeyService,
  agentClient,
  agentOperations,
});

const sandboxDestroyer = new SandboxDestroyer({
  sandboxService,
});

const sandboxLifecycle = new SandboxLifecycle({
  sandboxService,
  agentClient,
});

const prebuildRunner = new PrebuildRunner({
  sandboxSpawner,
  sandboxDestroyer,
  sandboxService,
  workspaceService,
  agentClient,
});

const taskSpawner = new TaskSpawner({
  sandboxSpawner,
  sandboxService,
  taskService,
  workspaceService,
  sessionTemplateService,
  agentClient,
});

const prebuildChecker = new PrebuildChecker({
  workspaceService,
  gitSourceService,
  prebuildRunner,
});

export {
  agentClient,
  agentOperations,
  configFileService,
  gitSourceService,
  internalService,
  prebuildChecker,
  prebuildRunner,
  sandboxDestroyer,
  sandboxLifecycle,
  sandboxService,
  sandboxSpawner,
  sshKeyService,
  taskService,
  taskSpawner,
  sessionTemplateService,
  workspaceService,
};
