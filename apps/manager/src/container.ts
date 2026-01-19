import { AgentClient } from "./infrastructure/agent/index.ts";
import {
  ConfigFileRepository,
  ConfigFileService,
} from "./modules/config-file/index.ts";
import {
  GitSourceRepository,
  GitSourceService,
} from "./modules/git-source/index.ts";
import { PrebuildService } from "./modules/prebuild/index.ts";
import { SandboxRepository, SandboxService } from "./modules/sandbox/index.ts";
import {
  WorkspaceRepository,
  WorkspaceService,
} from "./modules/workspace/index.ts";

// Repositories
const configFileRepository = new ConfigFileRepository();
const gitSourceRepository = new GitSourceRepository();
const workspaceRepository = new WorkspaceRepository();
const sandboxRepository = new SandboxRepository();

// Services (simple, no cross-dependencies)
const configFileService = new ConfigFileService(configFileRepository);
const gitSourceService = new GitSourceService(gitSourceRepository);

// Late-bound reference to break circular dependency
let _sandboxService: SandboxService | undefined;

// AgentClient uses lazy getter - sandboxService will be assigned before any actual usage
const agentClient: AgentClient = new AgentClient((id) => {
  if (!_sandboxService) {
    throw new Error("SandboxService not initialized");
  }
  return _sandboxService.getById(id);
});

// Late-bound reference for workspace/prebuild cycle
let _workspaceService: WorkspaceService | undefined;

const sandboxService: SandboxService = new SandboxService(sandboxRepository, {
  getWorkspace: (id) => {
    if (!_workspaceService) {
      throw new Error("WorkspaceService not initialized");
    }
    return _workspaceService.getById(id);
  },
  getGitSource: (id) => gitSourceService.getById(id),
  getConfigFiles: (workspaceId) =>
    configFileService.getMergedForSandbox(workspaceId),
  agentClient,
});

// Now assign the late-bound reference
_sandboxService = sandboxService;

const prebuildService: PrebuildService = new PrebuildService({
  getWorkspace: (id) => {
    if (!_workspaceService) {
      throw new Error("WorkspaceService not initialized");
    }
    return _workspaceService.getById(id);
  },
  updateWorkspace: (id, updates) => {
    if (!_workspaceService) {
      throw new Error("WorkspaceService not initialized");
    }
    try {
      return _workspaceService.update(id, updates);
    } catch {
      return undefined;
    }
  },
  spawnSandbox: (options) => sandboxService.spawn(options),
  destroySandbox: (id) => sandboxService.destroy(id),
  agentClient,
});

const workspaceService: WorkspaceService = new WorkspaceService(
  workspaceRepository,
  (workspaceId) => prebuildService.createInBackground(workspaceId),
);

// Complete the initialization
_workspaceService = workspaceService;

export const container = {
  repositories: {
    configFile: configFileRepository,
    gitSource: gitSourceRepository,
    workspace: workspaceRepository,
    sandbox: sandboxRepository,
  },
  services: {
    configFile: configFileService,
    gitSource: gitSourceService,
    workspace: workspaceService,
    sandbox: sandboxService,
    prebuild: prebuildService,
  },
  clients: {
    agent: agentClient,
  },
};

export {
  agentClient,
  configFileService,
  gitSourceService,
  prebuildService,
  sandboxService,
  workspaceService,
};
