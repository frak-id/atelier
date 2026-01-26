# Orchestrators

Complex multi-step workflows coordinating services and infrastructure.

## Orchestrators

| Orchestrator | LOC | Purpose |
|--------------|-----|---------|
| `SandboxSpawner` | 589 | Full VM creation (network → volume → FC → agent → routes) |
| `TaskSpawner` | 603 | Task execution (sandbox → session → git branch → prompt) |
| `SandboxDestroyer` | 65 | Cleanup with rollback (reverse of spawner) |
| `SandboxLifecycle` | 257 | Health monitoring and state management |
| `PrebuildRunner` | 335 | Prebuild snapshot creation |
| `PrebuildChecker` | 133 | Staleness detection and rebuild triggers |

## Pattern: Context-Based Execution

```typescript
class SandboxSpawner {
  async spawn(options: CreateSandboxBody): Promise<Sandbox> {
    const context = new SpawnContext(this.deps, options);
    return context.execute();
  }
}

class SpawnContext {
  private sandboxId: string;
  private network?: NetworkAllocation;
  private paths?: SandboxPaths;
  
  async execute(): Promise<Sandbox> {
    try {
      await this.allocateNetwork();
      await this.createVolume();
      await this.provisionFilesystem();
      await this.spawnFirecracker();
      await this.waitForAgent();
      await this.registerRoutes();
      return this.finalize();
    } catch (error) {
      await this.rollback();
      throw error;
    }
  }
}
```

## Rollback Pattern

Cleanup in **reverse order** of creation:

```typescript
private async rollback(): Promise<void> {
  if (this.pid) await killProcess(this.pid);
  if (this.socketPath) await deleteSocket();
  if (this.paths?.useLvm) await StorageService.deleteVolume();
  if (this.network?.tapDevice) await NetworkService.deleteTap();
  if (this.network?.ipAddress) NetworkService.release();
}
```

## SandboxSpawner Flow

```
1. loadWorkspace()        → Get workspace config
2. allocateNetwork()      → IP + MAC + TAP device
3. createVolume()         → LVM snapshot from base/prebuild
4. provisionFilesystem()  → Mount + inject configs + unmount
5. spawnFirecracker()     → Start FC process
6. configureVm()          → Set boot source, drives, network via socket
7. startVm()              → InstanceStart action
8. waitForAgent()         → Poll :9999/health until ready
9. registerRoutes()       → Caddy + SSHPiper routes
10. runStartCommands()    → Execute workspace start commands
```

## TaskSpawner Flow

```
1. createTask()           → DB record with "spawning" status
2. spawnSandbox()         → Delegate to SandboxSpawner
3. createGitBranch()      → Branch from workspace default
4. buildPrompt()          → Construct AI prompt with context
5. startSession()         → OpenCode session via agent
6. updateTask()           → Status "running", attach sandbox
```

## Dependencies

Orchestrators receive dependencies via constructor:

```typescript
const sandboxSpawner = new SandboxSpawner({
  sandboxService,
  workspaceService,
  gitSourceService,
  configFileService,
  sshKeyService,
  agentClient,
});
```

Wired in `container.ts`, imported by routes.

## When to Add Orchestrator

- Multi-step workflow with rollback requirements
- Coordination across 3+ services/infrastructure
- State machine behavior (status transitions)
- Long-running operations with progress tracking
