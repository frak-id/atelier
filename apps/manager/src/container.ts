import { AgentClient } from "./infrastructure/agent/index.ts";
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
import { SshKeyRepository, SshKeyService } from "./modules/ssh-key/index.ts";
import {
  WorkspaceRepository,
  WorkspaceService,
} from "./modules/workspace/index.ts";
import {
  PrebuildRunner,
  SandboxDestroyer,
  SandboxLifecycle,
  SandboxSpawner,
} from "./orchestrators/index.ts";

/* -------------------------------------------------------------------------- */
/*                                Repositories                                */
/* -------------------------------------------------------------------------- */

const configFileRepository = new ConfigFileRepository();
const gitSourceRepository = new GitSourceRepository();
const sshKeyRepository = new SshKeyRepository();
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
const sandboxService = new SandboxService(sandboxRepository);
const internalService = new InternalService(
  sharedAuthRepository,
  configFileService,
);

const agentClient = new AgentClient();

/* -------------------------------------------------------------------------- */
/*                                Orchestrators                               */
/* -------------------------------------------------------------------------- */

const sandboxSpawner = new SandboxSpawner({
  sandboxService,
  workspaceService,
  gitSourceService,
  configFileService,
  agentClient,
});

const sandboxDestroyer = new SandboxDestroyer({
  sandboxService,
});

const sandboxLifecycle = new SandboxLifecycle({
  sandboxService,
});

const prebuildRunner = new PrebuildRunner({
  sandboxSpawner,
  sandboxDestroyer,
  sandboxService,
  workspaceService,
  agentClient,
});

export {
  agentClient,
  configFileService,
  gitSourceService,
  internalService,
  prebuildRunner,
  sandboxDestroyer,
  sandboxLifecycle,
  sandboxService,
  sandboxSpawner,
  sshKeyService,
  workspaceService,
};
