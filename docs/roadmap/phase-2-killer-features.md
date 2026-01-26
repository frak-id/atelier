# Phase 2: Killer Features

> Differentiate FRAK with enterprise-grade features based on community feedback

**Timeline:** 8-12 weeks (after Phase 1)
**Total Effort:** ~150-200 hours
**Trigger:** Community feedback, early adopter requests
**Status:** Planning

---

## Executive Summary

Phase 2 transforms FRAK from "a good sandbox tool" into "the enterprise platform for secure, isolated compute" with four pillars:

1. **Infrastructure Abstraction** - Swap providers without code changes
2. **Multi-Host Swarm** - Scale horizontally across servers
3. **AI Agent Runtime** - Purpose-built for autonomous agents
4. **Air-Gapped Enterprise** - Fully local, zero external dependencies

---

## Strategic Context

### Market Signals (2025-2026)

| Signal | Implication for FRAK |
|--------|---------------------|
| Gitpod → Ona (AI agents) | AI runtime is the future |
| Daytona pivots to AI | <100ms sandboxes for agents |
| Coder adds AI governance | Enterprise wants control |
| DevPod grows 14k stars | Self-hosted wins |
| Fly.io $467M valuation | Firecracker at scale works |

### FRAK's Unique Position

```
                    Security
                       ▲
                       │
              FRAK ────┼──── Enterprise
             (VMs)     │     sweet spot
                       │
    Containers ────────┼──────────────► Speed
    (Docker)           │
                       │
```

**We offer:** VM-level isolation + container-like speed + self-hosted simplicity.

---

## 1. Infrastructure Provider Interfaces

**Priority:** High
**Effort:** 30 hours
**Dependencies:** Phase 1 (circular dependency fix)

### Problem

Current architecture is hardcoded to:
- **VM Provider:** Firecracker only
- **Storage:** LVM only
- **Network:** Linux bridge + iptables only
- **Proxy:** Caddy only

This prevents:
- Local development without Linux/KVM
- Alternative hypervisors (QEMU, Cloud Hypervisor)
- Alternative storage (APFS, ZFS, S3)
- Alternative proxies (Nginx, Traefik)

### Solution

Create provider interfaces that can be swapped at configuration time.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Manager Application                       │
├─────────────────────────────────────────────────────────────┤
│                    Provider Interfaces                       │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌────────┐│
│  │ VMProvider  │ │StorageProvider│ │NetworkProvider│ │ProxyProv││
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘ └────┬───┘│
└─────────┼───────────────┼───────────────┼──────────────┼────┘
          │               │               │              │
    ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐  ┌────┴────┐
    │Firecracker│   │    LVM    │   │   Bridge  │  │  Caddy  │
    │   QEMU    │   │   APFS    │   │   VXLAN   │  │  Nginx  │
    │   Mock    │   │   File    │   │   Mock    │  │ Traefik │
    └───────────┘   └───────────┘   └───────────┘  └─────────┘
```

### Interface Definitions

```typescript
// packages/shared/src/providers/vm.provider.ts

export interface VMConfig {
  id: string;
  vcpus: number;
  memoryMb: number;
  rootfsDrive: string;
  kernelPath: string;
  networkConfig: {
    tapDevice: string;
    macAddress: string;
    ipAddress: string;
    gateway: string;
  };
  bootArgs?: string;
}

export interface VMStatus {
  state: 'running' | 'paused' | 'stopped' | 'error';
  pid?: number;
  uptime?: number;
  error?: string;
}

export interface VMProvider {
  /**
   * Provider identifier (e.g., 'firecracker', 'qemu', 'mock')
   */
  readonly name: string;

  /**
   * Check if this provider is available on the current system
   */
  isAvailable(): Promise<boolean>;

  /**
   * Spawn a new VM with the given configuration
   */
  spawn(config: VMConfig): Promise<{ pid: number }>;

  /**
   * Get the current status of a VM
   */
  getStatus(id: string): Promise<VMStatus>;

  /**
   * Pause a running VM (freeze state)
   */
  pause(id: string): Promise<void>;

  /**
   * Resume a paused VM
   */
  resume(id: string): Promise<void>;

  /**
   * Stop a VM gracefully
   */
  stop(id: string): Promise<void>;

  /**
   * Force kill a VM
   */
  kill(id: string): Promise<void>;

  /**
   * Execute command in VM (if supported)
   */
  exec?(id: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
```

```typescript
// packages/shared/src/providers/storage.provider.ts

export interface VolumeConfig {
  name: string;
  sizeGb: number;
  source?: string; // Clone from this volume
}

export interface VolumeInfo {
  name: string;
  path: string;
  sizeGb: number;
  usedGb: number;
  createdAt: Date;
}

export interface StorageProvider {
  readonly name: string;

  isAvailable(): Promise<boolean>;

  /**
   * Create a new volume (empty or cloned from source)
   */
  createVolume(config: VolumeConfig): Promise<string>; // Returns device path

  /**
   * Delete a volume
   */
  deleteVolume(name: string): Promise<void>;

  /**
   * Create instant snapshot (for prebuilds)
   */
  snapshot(source: string, target: string): Promise<string>;

  /**
   * Get volume information
   */
  getVolumeInfo(name: string): Promise<VolumeInfo>;

  /**
   * Get pool statistics
   */
  getPoolStats(): Promise<{
    totalGb: number;
    usedGb: number;
    availableGb: number;
    volumeCount: number;
  }>;
}
```

```typescript
// packages/shared/src/providers/network.provider.ts

export interface NetworkAllocation {
  ipAddress: string;
  macAddress: string;
  tapDevice: string;
  gateway: string;
  dns: string[];
}

export interface NetworkProvider {
  readonly name: string;

  isAvailable(): Promise<boolean>;

  /**
   * Allocate network resources for a new VM
   */
  allocate(sandboxId: string): Promise<NetworkAllocation>;

  /**
   * Release network resources
   */
  release(sandboxId: string): Promise<void>;

  /**
   * Create TAP device and attach to bridge
   */
  createTapDevice(name: string): Promise<void>;

  /**
   * Delete TAP device
   */
  deleteTapDevice(name: string): Promise<void>;

  /**
   * Get allocated IPs
   */
  getAllocations(): Promise<Map<string, NetworkAllocation>>;
}
```

```typescript
// packages/shared/src/providers/proxy.provider.ts

export interface ProxyRoute {
  sandboxId: string;
  subdomain: string;
  target: string; // e.g., "172.16.0.10:8080"
  https: boolean;
}

export interface ProxyProvider {
  readonly name: string;

  isAvailable(): Promise<boolean>;

  /**
   * Register routes for a sandbox
   */
  registerRoutes(routes: ProxyRoute[]): Promise<void>;

  /**
   * Remove routes for a sandbox
   */
  removeRoutes(sandboxId: string): Promise<void>;

  /**
   * Get all registered routes
   */
  getRoutes(): Promise<ProxyRoute[]>;

  /**
   * Reload configuration (if needed)
   */
  reload(): Promise<void>;
}
```

### Provider Implementations

**Firecracker VM Provider (Production):**
```typescript
// apps/manager/src/infrastructure/providers/firecracker.provider.ts
export class FirecrackerProvider implements VMProvider {
  readonly name = 'firecracker';

  async isAvailable(): Promise<boolean> {
    try {
      await access('/dev/kvm', constants.R_OK | constants.W_OK);
      await access(FIRECRACKER.BINARY_PATH, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async spawn(config: VMConfig): Promise<{ pid: number }> {
    // Current firecracker.client.ts implementation
  }
  // ...
}
```

**Mock VM Provider (Development):**
```typescript
// apps/manager/src/infrastructure/providers/mock-vm.provider.ts
export class MockVMProvider implements VMProvider {
  readonly name = 'mock';
  private vms = new Map<string, VMStatus>();

  async isAvailable(): Promise<boolean> {
    return true; // Always available
  }

  async spawn(config: VMConfig): Promise<{ pid: number }> {
    const pid = Math.floor(Math.random() * 100000);
    this.vms.set(config.id, { state: 'running', pid, uptime: 0 });
    return { pid };
  }

  async getStatus(id: string): Promise<VMStatus> {
    return this.vms.get(id) ?? { state: 'stopped' };
  }
  // ...
}
```

**QEMU VM Provider (Future):**
```typescript
// For macOS development via Lima or direct QEMU
export class QemuProvider implements VMProvider {
  readonly name = 'qemu';
  // ...
}
```

### Provider Registry

```typescript
// apps/manager/src/infrastructure/providers/registry.ts

export class ProviderRegistry {
  private vmProviders = new Map<string, VMProvider>();
  private storageProviders = new Map<string, StorageProvider>();
  private networkProviders = new Map<string, NetworkProvider>();
  private proxyProviders = new Map<string, ProxyProvider>();

  register<T>(type: 'vm' | 'storage' | 'network' | 'proxy', provider: T) {
    // ...
  }

  async selectBest(type: 'vm'): Promise<VMProvider> {
    // Return first available provider in priority order
    for (const [name, provider] of this.vmProviders) {
      if (await provider.isAvailable()) {
        return provider;
      }
    }
    throw new Error('No VM provider available');
  }

  get(type: 'vm', name: string): VMProvider {
    const provider = this.vmProviders.get(name);
    if (!provider) throw new Error(`Unknown VM provider: ${name}`);
    return provider;
  }
}

// Usage in container.ts
const registry = new ProviderRegistry();
registry.register('vm', new FirecrackerProvider());
registry.register('vm', new MockVMProvider());

const vmProvider = config.vmProvider
  ? registry.get('vm', config.vmProvider)
  : await registry.selectBest('vm');
```

### Configuration

```yaml
# config.yaml
providers:
  vm: firecracker      # or: mock, qemu
  storage: lvm         # or: file, apfs
  network: bridge      # or: vxlan, mock
  proxy: caddy         # or: nginx, traefik
```

### Tasks

- [ ] Define provider interfaces (TypeBox schemas)
- [ ] Extract current Firecracker code to FirecrackerProvider
- [ ] Extract current LVM code to LvmStorageProvider
- [ ] Extract current network code to BridgeNetworkProvider
- [ ] Extract current Caddy code to CaddyProxyProvider
- [ ] Implement MockVMProvider for development
- [ ] Implement FileStorageProvider (sparse files) as LVM fallback
- [ ] Create ProviderRegistry
- [ ] Add provider selection in config
- [ ] Update container.ts to use registry
- [ ] Write tests for each provider
- [ ] Document provider development

### Acceptance Criteria

- [ ] Can run full manager in mock mode without Firecracker
- [ ] Can swap providers via configuration
- [ ] Existing functionality unchanged
- [ ] New providers can be added without core changes

---

## 2. Multi-Host Swarm Architecture

**Priority:** High
**Effort:** 60 hours
**Dependencies:** Provider interfaces

See [Swarm Architecture Spec](./swarm-architecture.md) for complete technical design.

### Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    MANAGER NODE                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ API + Dashboard + Scheduler + State + Registry         │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────┬──────────────────────────────────┘
                           │ Control Plane
         ┌─────────────────┼─────────────────┐
         │                 │                 │
    ┌────▼────┐       ┌────▼────┐       ┌────▼────┐
    │ HOST 1  │       │ HOST 2  │       │ HOST 3  │
    │ Agent   │◄─────►│ Agent   │◄─────►│ Agent   │
    │ VMs     │ VXLAN │ VMs     │ VXLAN │ VMs     │
    └─────────┘       └─────────┘       └─────────┘
```

### Key Components

1. **Host Agent** - Lightweight daemon on each worker node
2. **Image Registry** - OCI registry on manager for rootfs distribution
3. **VXLAN Overlay** - Cross-host VM networking
4. **Scheduler** - Place VMs on hosts based on resources
5. **Health Monitoring** - Detect and handle host failures

### Implementation Phases

**Phase 2.1: Single Manager + Multiple Hosts (MVP)**
- Host agent daemon
- Registry-based image distribution
- Basic scheduler (round-robin)
- VXLAN overlay networking

**Phase 2.2: Advanced Scheduling**
- Resource-aware placement
- Affinity/anti-affinity rules
- Preemption and migration

**Phase 2.3: High Availability (Future)**
- 3-manager Raft consensus
- Automatic failover
- Shared storage for live migration

### Tasks

- [ ] Design host agent API
- [ ] Implement host agent daemon
- [ ] Add OCI registry to manager
- [ ] Implement image pull on hosts
- [ ] Implement VXLAN overlay
- [ ] Implement basic scheduler
- [ ] Add host registration/discovery
- [ ] Add health monitoring
- [ ] Update dashboard for multi-host view
- [ ] Write deployment documentation

### Acceptance Criteria

- [ ] Can add new hosts with single command
- [ ] VMs can communicate across hosts
- [ ] Manager routes traffic to any host
- [ ] Host failure detected within 30 seconds
- [ ] Images pulled efficiently (not on every spawn)

---

## 3. AI Agent Runtime Mode

**Priority:** Medium
**Effort:** 40 hours
**Dependencies:** Provider interfaces

### Context

The developer sandbox market is pivoting to AI agent runtimes:
- **Gitpod → Ona:** "Mission control for AI agents"
- **Daytona:** "<90ms sandboxes for agent workflows"
- **Coder:** "AI agent governance stack"

### FRAK's Advantage

```
┌─────────────────────────────────────────────────────────────┐
│               Why Firecracker for AI Agents?                 │
├─────────────────────────────────────────────────────────────┤
│ 1. TRUE ISOLATION                                           │
│    - VM boundary, not container namespace                    │
│    - Agents can't escape to host                            │
│    - Safe for untrusted code execution                      │
│                                                              │
│ 2. INSTANT STARTUP                                          │
│    - ~125ms cold start                                      │
│    - <5ms resume from pause                                 │
│    - LVM snapshots for instant clones                       │
│                                                              │
│ 3. RESOURCE CONTROL                                         │
│    - Hard CPU/memory limits                                 │
│    - No noisy neighbor                                      │
│    - Predictable performance                                │
└─────────────────────────────────────────────────────────────┘
```

### SDK Design

```typescript
// packages/frak-sdk/src/index.ts

export class FrakClient {
  constructor(private config: { apiUrl: string; apiKey: string }) {}

  /**
   * Create a new sandbox for agent execution
   */
  async createSandbox(options: {
    image?: string;           // Base image (default: 'dev-base')
    vcpus?: number;           // CPU cores (default: 2)
    memoryMb?: number;        // Memory in MB (default: 2048)
    timeoutMs?: number;       // Max lifetime (default: 3600000)
    env?: Record<string, string>;
  }): Promise<Sandbox> {
    const response = await this.request('POST', '/api/sandboxes', options);
    return new Sandbox(this, response);
  }

  /**
   * Get an existing sandbox
   */
  async getSandbox(id: string): Promise<Sandbox> {
    const response = await this.request('GET', `/api/sandboxes/${id}`);
    return new Sandbox(this, response);
  }
}

export class Sandbox {
  constructor(
    private client: FrakClient,
    public readonly data: SandboxData
  ) {}

  /**
   * Execute a command and return the result
   */
  async exec(command: string, options?: {
    timeout?: number;
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<ExecResult> {
    return this.client.request('POST', `/api/sandboxes/${this.data.id}/exec`, {
      command,
      ...options,
    });
  }

  /**
   * Write a file to the sandbox
   */
  async writeFile(path: string, content: string | Buffer): Promise<void> {
    await this.client.request('POST', `/api/sandboxes/${this.data.id}/files`, {
      path,
      content: typeof content === 'string' ? content : content.toString('base64'),
      encoding: typeof content === 'string' ? 'utf-8' : 'base64',
    });
  }

  /**
   * Read a file from the sandbox
   */
  async readFile(path: string): Promise<string> {
    const response = await this.client.request('GET', 
      `/api/sandboxes/${this.data.id}/files?path=${encodeURIComponent(path)}`
    );
    return response.content;
  }

  /**
   * Create a snapshot for instant restore
   */
  async snapshot(name: string): Promise<Snapshot> {
    return this.client.request('POST', `/api/sandboxes/${this.data.id}/snapshots`, {
      name,
    });
  }

  /**
   * Restore from a snapshot
   */
  async restore(snapshotId: string): Promise<void> {
    await this.client.request('POST', `/api/sandboxes/${this.data.id}/restore`, {
      snapshotId,
    });
  }

  /**
   * Destroy the sandbox
   */
  async destroy(): Promise<void> {
    await this.client.request('DELETE', `/api/sandboxes/${this.data.id}`);
  }
}

// Usage example
const frak = new FrakClient({
  apiUrl: 'https://sandbox-api.mycompany.com',
  apiKey: process.env.FRAK_API_KEY,
});

const sandbox = await frak.createSandbox({
  vcpus: 4,
  memoryMb: 8192,
  timeoutMs: 300000, // 5 minutes max
});

// Execute agent task
const result = await sandbox.exec('python agent.py --task "analyze code"');
console.log(result.stdout);

// Take snapshot for checkpoint
const snapshot = await sandbox.snapshot('after-analysis');

// Continue with more work...
await sandbox.exec('python agent.py --task "fix bugs"');

// If something goes wrong, restore
await sandbox.restore(snapshot.id);

// Clean up
await sandbox.destroy();
```

### Python SDK

```python
# packages/frak-sdk-python/frak/__init__.py

from dataclasses import dataclass
from typing import Optional, Dict
import httpx

@dataclass
class ExecResult:
    stdout: str
    stderr: str
    exit_code: int

class Sandbox:
    def __init__(self, client: 'FrakClient', data: dict):
        self._client = client
        self.id = data['id']
        self.status = data['status']
        self.ip_address = data['ipAddress']

    async def exec(
        self,
        command: str,
        timeout: Optional[int] = None,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> ExecResult:
        """Execute a command in the sandbox."""
        response = await self._client._request(
            'POST',
            f'/api/sandboxes/{self.id}/exec',
            json={'command': command, 'timeout': timeout, 'cwd': cwd, 'env': env},
        )
        return ExecResult(**response)

    async def write_file(self, path: str, content: str) -> None:
        """Write a file to the sandbox."""
        await self._client._request(
            'POST',
            f'/api/sandboxes/{self.id}/files',
            json={'path': path, 'content': content},
        )

    async def read_file(self, path: str) -> str:
        """Read a file from the sandbox."""
        response = await self._client._request(
            'GET',
            f'/api/sandboxes/{self.id}/files',
            params={'path': path},
        )
        return response['content']

    async def destroy(self) -> None:
        """Destroy the sandbox."""
        await self._client._request('DELETE', f'/api/sandboxes/{self.id}')

class FrakClient:
    def __init__(self, api_url: str, api_key: str):
        self.api_url = api_url
        self._http = httpx.AsyncClient(
            headers={'Authorization': f'Bearer {api_key}'},
        )

    async def create_sandbox(
        self,
        image: str = 'dev-base',
        vcpus: int = 2,
        memory_mb: int = 2048,
        timeout_ms: int = 3600000,
        env: Optional[Dict[str, str]] = None,
    ) -> Sandbox:
        """Create a new sandbox."""
        response = await self._request(
            'POST',
            '/api/sandboxes',
            json={
                'image': image,
                'vcpus': vcpus,
                'memoryMb': memory_mb,
                'timeoutMs': timeout_ms,
                'env': env or {},
            },
        )
        return Sandbox(self, response)

# Usage
import asyncio
from frak import FrakClient

async def main():
    client = FrakClient(
        api_url='https://sandbox-api.mycompany.com',
        api_key=os.environ['FRAK_API_KEY'],
    )

    sandbox = await client.create_sandbox(vcpus=4, memory_mb=8192)
    
    # Write agent code
    await sandbox.write_file('/home/dev/agent.py', agent_code)
    
    # Execute
    result = await sandbox.exec('python /home/dev/agent.py')
    print(result.stdout)
    
    await sandbox.destroy()

asyncio.run(main())
```

### API Additions

```typescript
// New endpoints for agent runtime

// File operations
POST   /api/sandboxes/:id/files     // Write file
GET    /api/sandboxes/:id/files     // Read file
DELETE /api/sandboxes/:id/files     // Delete file

// Snapshot operations
POST   /api/sandboxes/:id/snapshots     // Create snapshot
GET    /api/sandboxes/:id/snapshots     // List snapshots
POST   /api/sandboxes/:id/restore       // Restore from snapshot
DELETE /api/sandboxes/:id/snapshots/:snapId  // Delete snapshot

// Batch operations (for parallel agents)
POST   /api/sandboxes/batch             // Create multiple sandboxes
DELETE /api/sandboxes/batch             // Destroy multiple sandboxes
```

### Tasks

- [ ] Design SDK interfaces
- [ ] Implement TypeScript SDK
- [ ] Implement Python SDK
- [ ] Add file operation endpoints
- [ ] Add snapshot endpoints
- [ ] Add batch operation endpoints
- [ ] Optimize for <100ms sandbox creation
- [ ] Add usage metering (for billing)
- [ ] Write SDK documentation
- [ ] Create example agent integrations

### Acceptance Criteria

- [ ] SDK available on npm and PyPI
- [ ] Sandbox creation <200ms (target: <100ms)
- [ ] File operations work reliably
- [ ] Snapshots create/restore in <1 second
- [ ] Can run 100+ concurrent sandboxes

---

## 4. Air-Gapped Enterprise Mode

**Priority:** High
**Effort:** 30 hours
**Dependencies:** Provider interfaces, config extraction

### Problem

Enterprise customers with security requirements need:
- **Zero external network access** from sandboxes
- **Bring your own infrastructure** (no cloud dependencies)
- **Bring your own LLM** (on-prem models)
- **Complete audit trail**
- **Data sovereignty** (nothing leaves their network)

### Solution

"Enterprise Air-Gap Mode" - a deployment configuration for fully isolated operation.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 ENTERPRISE NETWORK (Air-Gapped)              │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              FRAK Manager + Dashboard                  │  │
│  │                                                        │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  │  │
│  │  │ OCI Registry│  │ NFS Storage │  │ Internal DNS │  │  │
│  │  │ (rootfs)    │  │ (shared bin)│  │ (sandbox.local)│ │  │
│  │  └─────────────┘  └─────────────┘  └──────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                           │                                  │
│         ┌─────────────────┼─────────────────┐               │
│         │                 │                 │               │
│    ┌────▼────┐       ┌────▼────┐       ┌────▼────┐         │
│    │ HOST 1  │       │ HOST 2  │       │ HOST 3  │         │
│    │         │       │         │       │         │         │
│    │ ┌─────┐ │       │ ┌─────┐ │       │ ┌─────┐ │         │
│    │ │ VM  │ │       │ │ VM  │ │       │ │ VM  │ │         │
│    │ │     │ │       │ │     │ │       │ │     │ │         │
│    │ │ No  │ │       │ │ No  │ │       │ │ No  │ │         │
│    │ │ WAN │ │       │ │ WAN │ │       │ │ WAN │ │         │
│    │ └─────┘ │       │ └─────┘ │       │ └─────┘ │         │
│    └─────────┘       └─────────┘       └─────────┘         │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  On-Prem LLM Server                    │  │
│  │  (Ollama / vLLM / llama.cpp / custom)                 │  │
│  │  http://llm.internal:11434                            │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│                    NO INTERNET ACCESS                        │
└─────────────────────────────────────────────────────────────┘
```

### Configuration

```yaml
# config.yaml - Air-gapped enterprise mode

mode: air-gapped

network:
  # No external access
  allowExternalAccess: false
  
  # Internal DNS only
  dnsServers:
    - 10.0.0.2  # Internal DNS server
  
  # Block all outbound except internal ranges
  allowedCidrs:
    - 10.0.0.0/8
    - 172.16.0.0/12
    - 192.168.0.0/16

# Internal services
services:
  registry:
    url: http://registry.internal:5000
    
  nfs:
    server: nfs.internal
    path: /shared/frak
    
  llm:
    provider: ollama
    url: http://llm.internal:11434
    model: codellama:34b

# Authentication (internal IdP)
auth:
  provider: oidc
  issuer: https://idp.internal
  clientId: frak-sandbox
  clientSecret: ${OIDC_SECRET}

# Audit logging
audit:
  enabled: true
  destination: syslog
  syslogServer: syslog.internal:514
  
# Compliance
compliance:
  dataRetention: 90d
  encryptAtRest: true
  encryptionKey: ${ENCRYPTION_KEY}
```

### Network Isolation

```typescript
// apps/manager/src/infrastructure/network/airgap.service.ts

export class AirGapNetworkService implements NetworkProvider {
  private readonly allowedCidrs: string[];

  async createTapDevice(name: string): Promise<void> {
    await super.createTapDevice(name);
    
    // Add iptables rules to block external access
    await this.blockExternalAccess(name);
  }

  private async blockExternalAccess(tapDevice: string): Promise<void> {
    // Drop all traffic except allowed CIDRs
    for (const cidr of this.allowedCidrs) {
      await exec(`iptables -A FORWARD -i ${tapDevice} -d ${cidr} -j ACCEPT`);
    }
    
    // Drop everything else
    await exec(`iptables -A FORWARD -i ${tapDevice} -j DROP`);
    
    // Log blocked attempts
    await exec(`iptables -A FORWARD -i ${tapDevice} -j LOG --log-prefix "FRAK-BLOCKED: "`);
  }
}
```

### Bring Your Own LLM Integration

```typescript
// packages/shared/src/providers/llm.provider.ts

export interface LLMProvider {
  readonly name: string;
  
  /**
   * Generate text completion
   */
  complete(prompt: string, options?: {
    maxTokens?: number;
    temperature?: number;
    stop?: string[];
  }): Promise<string>;
  
  /**
   * Stream text completion
   */
  stream(prompt: string, options?: {
    maxTokens?: number;
    temperature?: number;
    stop?: string[];
  }): AsyncGenerator<string>;
  
  /**
   * Get embeddings
   */
  embed(text: string): Promise<number[]>;
}

// Ollama implementation
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  
  constructor(private config: {
    url: string;
    model: string;
  }) {}
  
  async complete(prompt: string, options?: CompleteOptions): Promise<string> {
    const response = await fetch(`${this.config.url}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({
        model: this.config.model,
        prompt,
        stream: false,
        options: {
          num_predict: options?.maxTokens,
          temperature: options?.temperature,
          stop: options?.stop,
        },
      }),
    });
    
    const data = await response.json();
    return data.response;
  }
}

// vLLM implementation
export class VLLMProvider implements LLMProvider {
  readonly name = 'vllm';
  // OpenAI-compatible API
}

// Custom implementation hook
export class CustomLLMProvider implements LLMProvider {
  readonly name = 'custom';
  
  constructor(private handler: (prompt: string) => Promise<string>) {}
  
  async complete(prompt: string): Promise<string> {
    return this.handler(prompt);
  }
}
```

### Sandbox LLM Access

```typescript
// Inside sandbox, agents can access the configured LLM

// /etc/sandbox/llm-config.json (injected by provisioner)
{
  "provider": "ollama",
  "url": "http://llm.internal:11434",
  "model": "codellama:34b"
}

// Agent code (inside sandbox)
import { createLLMClient } from '@frak-sandbox/llm-client';

const llm = createLLMClient(); // Reads from /etc/sandbox/llm-config.json

const response = await llm.complete(`
  Analyze this code and suggest improvements:
  
  ${code}
`);
```

### Audit Logging

```typescript
// apps/manager/src/infrastructure/audit/audit.service.ts

export interface AuditEvent {
  timestamp: Date;
  actor: {
    type: 'user' | 'api-key' | 'system';
    id: string;
    ip?: string;
  };
  action: string;
  resource: {
    type: 'sandbox' | 'project' | 'image' | 'user';
    id: string;
  };
  details: Record<string, unknown>;
  outcome: 'success' | 'failure';
}

export class AuditService {
  async log(event: AuditEvent): Promise<void> {
    // Write to configured destination
    switch (this.config.destination) {
      case 'syslog':
        await this.sendToSyslog(event);
        break;
      case 'file':
        await this.writeToFile(event);
        break;
      case 'database':
        await this.writeToDatabase(event);
        break;
    }
  }
  
  // Query audit logs
  async query(filters: AuditQueryFilters): Promise<AuditEvent[]> {
    // ...
  }
}

// Usage in routes
app.post('/api/sandboxes', async ({ body, user }) => {
  const sandbox = await sandboxService.spawn(body);
  
  await auditService.log({
    timestamp: new Date(),
    actor: { type: 'user', id: user.id, ip: request.ip },
    action: 'sandbox.create',
    resource: { type: 'sandbox', id: sandbox.id },
    details: { vcpus: body.vcpus, memoryMb: body.memoryMb },
    outcome: 'success',
  });
  
  return sandbox;
});
```

### Tasks

- [ ] Design air-gap configuration schema
- [ ] Implement network isolation (iptables rules)
- [ ] Create LLM provider interface
- [ ] Implement Ollama provider
- [ ] Implement vLLM provider
- [ ] Add LLM config injection to sandboxes
- [ ] Implement audit logging service
- [ ] Add OIDC authentication provider
- [ ] Create air-gap deployment guide
- [ ] Test in isolated network environment

### Acceptance Criteria

- [ ] Sandboxes have zero external network access
- [ ] All dependencies served from internal sources
- [ ] LLM accessible from within sandboxes
- [ ] Complete audit trail of all actions
- [ ] Can deploy without any internet access

---

## Timeline

```
Week 1-4: Infrastructure Providers
├── Define interfaces [8h]
├── Extract to providers [16h]
└── Add mock/file fallbacks [6h]

Week 5-8: Multi-Host Swarm
├── Host agent [20h]
├── Image distribution [12h]
├── VXLAN networking [16h]
└── Basic scheduler [12h]

Week 9-10: AI Agent Runtime
├── SDK design [8h]
├── TypeScript SDK [12h]
├── Python SDK [12h]
└── New API endpoints [8h]

Week 11-12: Air-Gapped Mode
├── Network isolation [8h]
├── LLM providers [12h]
├── Audit logging [6h]
└── Documentation [4h]
```

---

## Feature Prioritization (Community Input)

After Phase 1 launch, we'll gather community feedback to prioritize:

| Feature | Votes | Status |
|---------|-------|--------|
| Multi-host swarm | - | Candidate |
| AI agent SDK | - | Candidate |
| Air-gapped mode | - | Candidate |
| GPU passthrough | - | Candidate |
| Workspace snapshots | - | Candidate |
| WireGuard mesh | - | Candidate |

**Vote on GitHub Discussions to influence priority!**

---

## Definition of Done

Phase 2 is complete when:

- [ ] Provider interfaces documented and implemented
- [ ] Can swap providers via configuration
- [ ] Multi-host deployment works with 3+ hosts
- [ ] SDK available on npm and PyPI
- [ ] Air-gapped deployment guide exists
- [ ] At least one enterprise pilot customer

---

## Success Metrics

| Metric | Target |
|--------|--------|
| SDK downloads (npm + PyPI) | 1,000/month |
| Multi-host deployments | 10 |
| Enterprise pilots | 3 |
| GitHub stars | 5,000 |
| Contributors | 20 |
