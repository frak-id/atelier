# Swarm Architecture Specification

> Technical design for multi-host FRAK Sandbox deployment

**Status:** Design Phase
**Target:** Phase 2.2
**Dependencies:** Provider interfaces (Phase 2.1)

---

## Overview

The swarm architecture enables horizontal scaling across multiple physical servers while maintaining a single management interface.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CONTROL PLANE                               │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                         MANAGER NODE                               │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ │  │
│  │  │ API      │ │ Dashboard│ │ Scheduler│ │ Registry │ │ State   │ │  │
│  │  │ :4000    │ │ :5173    │ │          │ │ :5000    │ │ (SQLite)│ │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └─────────┘ │  │
│  │                                                                    │  │
│  │  ┌─────────────────────────────────────────────────────────────┐  │  │
│  │  │                     Caddy (API Gateway)                      │  │  │
│  │  │  *.sandbox.example.com → Route to appropriate host           │  │  │
│  │  └─────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                         gRPC Control Channel
                                  │
         ┌────────────────────────┼────────────────────────┐
         │                        │                        │
         ▼                        ▼                        ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│    HOST 1       │    │    HOST 2       │    │    HOST 3       │
│  ┌───────────┐  │    │  ┌───────────┐  │    │  ┌───────────┐  │
│  │Host Agent │  │    │  │Host Agent │  │    │  │Host Agent │  │
│  │  :9998    │  │    │  │  :9998    │  │    │  │  :9998    │  │
│  └───────────┘  │    │  └───────────┘  │    │  └───────────┘  │
│                 │    │                 │    │                 │
│  ┌─────┬─────┐  │    │  ┌─────┬─────┐  │    │  ┌─────┬─────┐  │
│  │ VM1 │ VM2 │  │    │  │ VM4 │ VM5 │  │    │  │ VM7 │ VM8 │  │
│  └─────┴─────┘  │    │  └─────┴─────┘  │    │  └─────┴─────┘  │
│  │ VM3 │     │  │    │  │ VM6 │     │  │    │  │ VM9 │     │  │
│  └─────┴─────┘  │    │  └─────┴─────┘  │    │  └─────┴─────┘  │
│                 │    │                 │    │                 │
│  LVM: sandbox-vg│    │  LVM: sandbox-vg│    │  LVM: sandbox-vg│
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                      │
         └──────────────────────┴──────────────────────┘
                          VXLAN Overlay
                        (10.100.0.0/16)
```

---

## Components

### 1. Manager Node

The manager is the control plane, responsible for:
- API server (all client requests)
- Dashboard hosting
- Scheduler (VM placement decisions)
- State management (cluster state, VM registry)
- Image registry (rootfs distribution)
- Proxy gateway (route external traffic)

**Single manager limitation:** No HA in Phase 2.1. Future phases will add Raft consensus for 3+ managers.

### 2. Host Agent

Lightweight daemon running on each worker node.

**Responsibilities:**
- Register with manager on startup
- Report resource availability (CPU, RAM, disk)
- Execute VM lifecycle commands
- Report VM health metrics
- Pull images from manager registry

**Port:** 9998 (different from sandbox-agent's 9999)

### 3. Image Registry

OCI-compatible registry running on manager.

**Purpose:**
- Distribute rootfs images to hosts
- Cache layers for efficient transfer
- Support for private images

**Implementation:** `distribution/distribution` (Docker Registry v2)

### 4. VXLAN Overlay Network

Cross-host VM networking using VXLAN tunnels.

**Range:** 10.100.0.0/16 (65,536 addresses)
**VNI:** 42 (VXLAN Network Identifier)
**Port:** 4789 (UDP)

---

## Host Agent Design

### API Specification

```typescript
// packages/host-agent/src/types.ts

interface HostInfo {
  id: string;              // Unique host identifier
  hostname: string;
  ip: string;
  resources: {
    cpuCores: number;
    cpuUsage: number;      // 0-100%
    memoryTotalMb: number;
    memoryUsedMb: number;
    diskTotalGb: number;
    diskUsedGb: number;
  };
  capabilities: {
    kvm: boolean;
    lvm: boolean;
    vxlan: boolean;
  };
  vms: VMSummary[];
}

interface VMSummary {
  id: string;
  status: 'running' | 'paused' | 'stopped';
  vcpus: number;
  memoryMb: number;
  ipAddress: string;
}

interface SpawnRequest {
  sandboxId: string;
  image: string;           // Registry path: registry:5000/rootfs/dev-base
  vcpus: number;
  memoryMb: number;
  network: {
    ipAddress: string;     // Assigned by manager
    macAddress: string;
    gateway: string;
    dns: string[];
  };
  env?: Record<string, string>;
  secrets?: Record<string, string>;
}
```

### Endpoints

```
GET  /health              → Host health check
GET  /info                → Host information and resources
GET  /vms                 → List VMs on this host
POST /vms                 → Spawn new VM
GET  /vms/:id             → Get VM details
POST /vms/:id/stop        → Stop VM
POST /vms/:id/start       → Start VM
POST /vms/:id/pause       → Pause VM
POST /vms/:id/resume      → Resume VM
DELETE /vms/:id           → Destroy VM
POST /vms/:id/exec        → Execute command in VM
GET  /vms/:id/metrics     → Get VM metrics
POST /images/pull         → Pull image from registry
GET  /images              → List cached images
```

### Implementation

```typescript
// packages/host-agent/src/index.ts

import { Elysia } from 'elysia';
import { config } from './config';
import { FirecrackerProvider } from './providers/firecracker';
import { LvmStorageProvider } from './providers/lvm';
import { VxlanNetworkProvider } from './providers/vxlan';

const vm = new FirecrackerProvider();
const storage = new LvmStorageProvider();
const network = new VxlanNetworkProvider();

const app = new Elysia()
  .get('/health', () => ({ status: 'healthy' }))
  
  .get('/info', async () => ({
    id: config.hostId,
    hostname: os.hostname(),
    ip: config.hostIp,
    resources: await getResources(),
    capabilities: {
      kvm: await vm.isAvailable(),
      lvm: await storage.isAvailable(),
      vxlan: await network.isAvailable(),
    },
    vms: await vm.list(),
  }))
  
  .post('/vms', async ({ body }: { body: SpawnRequest }) => {
    // 1. Pull image if not cached
    await pullImageIfNeeded(body.image);
    
    // 2. Create LVM volume
    const volumePath = await storage.createVolume({
      name: `sandbox-${body.sandboxId}`,
      source: body.image,
    });
    
    // 3. Setup VXLAN interface for this VM
    await network.setupVm(body.sandboxId, body.network);
    
    // 4. Spawn Firecracker VM
    const result = await vm.spawn({
      id: body.sandboxId,
      vcpus: body.vcpus,
      memoryMb: body.memoryMb,
      rootfsDrive: volumePath,
      networkConfig: body.network,
    });
    
    return { success: true, pid: result.pid };
  })
  
  .delete('/vms/:id', async ({ params }) => {
    // 1. Stop VM
    await vm.kill(params.id);
    
    // 2. Cleanup network
    await network.cleanupVm(params.id);
    
    // 3. Delete storage
    await storage.deleteVolume(`sandbox-${params.id}`);
    
    return { success: true };
  })
  
  .listen(config.port);

// Register with manager on startup
registerWithManager();

// Heartbeat loop
setInterval(sendHeartbeat, 10000);
```

### Registration Flow

```
Host Agent                                Manager
    │                                        │
    │  POST /api/hosts/register              │
    │  { id, hostname, ip, resources }       │
    │───────────────────────────────────────>│
    │                                        │
    │  { token, registryUrl, vxlanConfig }   │
    │<───────────────────────────────────────│
    │                                        │
    │  [Every 10s] POST /api/hosts/heartbeat │
    │  { id, resources, vms }                │
    │───────────────────────────────────────>│
    │                                        │
```

---

## Image Distribution

### Registry Setup

```yaml
# Manager: docker-compose.yml for registry
version: '3'
services:
  registry:
    image: registry:2
    ports:
      - "5000:5000"
    volumes:
      - ./registry-data:/var/lib/registry
    environment:
      REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: /var/lib/registry
```

### Image Format

Rootfs images are stored as OCI images:

```
registry:5000/frak/rootfs/dev-base:latest
registry:5000/frak/rootfs/dev-cloud:latest
registry:5000/frak/prebuilds/{projectId}:{hash}
```

### Push Image (Manager)

```typescript
// apps/manager/src/services/registry.service.ts

async function pushImage(imageName: string, rootfsPath: string): Promise<void> {
  // 1. Create OCI image from ext4 file
  const tarPath = await createTar(rootfsPath);
  
  // 2. Calculate digest
  const digest = await sha256(tarPath);
  
  // 3. Push to registry
  await pushBlob(tarPath, digest);
  await pushManifest(imageName, digest);
}
```

### Pull Image (Host Agent)

```typescript
// packages/host-agent/src/services/image.service.ts

async function pullImage(imageName: string): Promise<string> {
  const localPath = `/var/lib/sandbox/images/${imageName.replace(/[:/]/g, '-')}`;
  
  // Check if already cached
  if (await exists(localPath)) {
    return localPath;
  }
  
  // Pull from registry
  const manifest = await fetchManifest(imageName);
  const blob = await fetchBlob(manifest.layers[0].digest);
  
  // Extract to local storage
  await extractTar(blob, localPath);
  
  return localPath;
}
```

### P2P Image Sharing (Optimization)

For large clusters, hosts can share images peer-to-peer:

```
Manager                Host A              Host B              Host C
   │                     │                   │                   │
   │  Push image         │                   │                   │
   │────────────────────>│                   │                   │
   │                     │                   │                   │
   │                     │  Advertise layer  │                   │
   │                     │──────────────────>│                   │
   │                     │                   │                   │
   │                     │  Request layer    │  Has layer?       │
   │                     │<──────────────────│<──────────────────│
   │                     │                   │                   │
   │                     │  Send layer (P2P) │                   │
   │                     │──────────────────>│                   │
   │                     │                   │                   │
   │                     │                   │  Send layer (P2P) │
   │                     │                   │──────────────────>│
```

---

## VXLAN Overlay Network

### Concept

VXLAN (Virtual Extensible LAN) creates L2 networks over L3 infrastructure.

```
VM on Host 1 (10.100.0.10)  ──────────────>  VM on Host 2 (10.100.0.20)
        │                                              │
        │ Encapsulated in                              │
        │ VXLAN+UDP                                    │
        ▼                                              ▼
    Host 1 (192.168.1.10)  ────── Physical ────>  Host 2 (192.168.1.20)
                               Network
```

### Setup (Each Host)

```bash
# Create VXLAN interface
ip link add vxlan0 type vxlan \
  id 42 \
  dstport 4789 \
  local 192.168.1.10 \
  dev eth0 \
  nolearning

# Create bridge for VXLAN
ip link add br-vxlan type bridge
ip link set vxlan0 master br-vxlan
ip link set vxlan0 up
ip link set br-vxlan up

# Assign overlay IP to bridge
ip addr add 10.100.0.1/16 dev br-vxlan
```

### Forwarding Table Management

Manager maintains the forwarding table and pushes updates to hosts:

```typescript
// apps/manager/src/services/vxlan.service.ts

interface VxlanEntry {
  vmId: string;
  macAddress: string;
  ipAddress: string;     // Overlay IP (10.100.x.x)
  hostIp: string;        // Physical host IP
}

async function addVmToOverlay(entry: VxlanEntry): Promise<void> {
  // Notify all hosts about new VM
  for (const host of await getHosts()) {
    await host.addFdbEntry({
      mac: entry.macAddress,
      dst: entry.hostIp,
    });
  }
}

// Host agent implementation
async function addFdbEntry(mac: string, dst: string): Promise<void> {
  await exec(`bridge fdb append ${mac} dev vxlan0 dst ${dst}`);
}
```

### IP Allocation

Manager allocates overlay IPs from 10.100.0.0/16:

```typescript
// apps/manager/src/services/ip-allocator.service.ts

class OverlayIpAllocator {
  private allocated = new Set<string>();
  private nextIp = 10; // Start at 10.100.0.10
  
  allocate(): string {
    while (this.allocated.has(`10.100.0.${this.nextIp}`)) {
      this.nextIp++;
      if (this.nextIp > 65534) {
        throw new Error('IP pool exhausted');
      }
    }
    
    const ip = `10.100.0.${this.nextIp}`;
    this.allocated.add(ip);
    return ip;
  }
  
  release(ip: string): void {
    this.allocated.delete(ip);
  }
}
```

### VM Network Configuration

Each VM gets:
- Overlay IP: 10.100.x.x
- Gateway: 10.100.0.1 (host's br-vxlan)
- DNS: From configuration

```bash
# Inside VM (set by sandbox-init)
ip addr add 10.100.0.10/16 dev eth0
ip route add default via 10.100.0.1
echo "nameserver 8.8.8.8" > /etc/resolv.conf
```

---

## Scheduler

### Placement Strategy

```typescript
// apps/manager/src/services/scheduler.service.ts

interface SchedulerStrategy {
  /**
   * Select best host for a new VM
   */
  selectHost(
    request: SpawnRequest,
    hosts: HostInfo[]
  ): Promise<HostInfo>;
}

// Round-robin (Phase 2.1 - Simple)
class RoundRobinStrategy implements SchedulerStrategy {
  private lastIndex = 0;
  
  async selectHost(request: SpawnRequest, hosts: HostInfo[]): Promise<HostInfo> {
    const available = hosts.filter(h => 
      h.resources.memoryUsedMb + request.memoryMb < h.resources.memoryTotalMb * 0.9
    );
    
    if (available.length === 0) {
      throw new Error('No hosts with sufficient resources');
    }
    
    this.lastIndex = (this.lastIndex + 1) % available.length;
    return available[this.lastIndex];
  }
}

// Resource-aware (Phase 2.2 - Advanced)
class ResourceAwareStrategy implements SchedulerStrategy {
  async selectHost(request: SpawnRequest, hosts: HostInfo[]): Promise<HostInfo> {
    // Score each host
    const scored = hosts.map(host => ({
      host,
      score: this.calculateScore(host, request),
    }));
    
    // Sort by score (higher is better)
    scored.sort((a, b) => b.score - a.score);
    
    if (scored[0].score <= 0) {
      throw new Error('No suitable hosts found');
    }
    
    return scored[0].host;
  }
  
  private calculateScore(host: HostInfo, request: SpawnRequest): number {
    let score = 100;
    
    // Memory fit (prefer hosts with more headroom)
    const memoryAfter = host.resources.memoryUsedMb + request.memoryMb;
    const memoryRatio = memoryAfter / host.resources.memoryTotalMb;
    if (memoryRatio > 0.95) return -1; // Can't fit
    score -= memoryRatio * 30;
    
    // CPU fit
    const cpuRatio = host.resources.cpuUsage / 100;
    score -= cpuRatio * 20;
    
    // Disk fit
    const diskRatio = host.resources.diskUsedGb / host.resources.diskTotalGb;
    if (diskRatio > 0.9) return -1; // Too full
    score -= diskRatio * 10;
    
    // Prefer spreading VMs across hosts
    score -= host.vms.length * 2;
    
    return score;
  }
}
```

### Affinity Rules (Future)

```typescript
interface AffinityRule {
  type: 'required' | 'preferred';
  key: string;
  operator: 'in' | 'notIn' | 'exists';
  values: string[];
}

// Example: Keep project VMs together
{
  type: 'preferred',
  key: 'projectId',
  operator: 'in',
  values: ['wallet']
}

// Example: Spread across availability zones
{
  type: 'required',
  key: 'zone',
  operator: 'notIn',
  values: ['us-east-1a'] // Already have VM there
}
```

---

## State Management

### Cluster State (Manager)

```typescript
// apps/manager/src/state/cluster.state.ts

interface ClusterState {
  hosts: Map<string, HostState>;
  vms: Map<string, VMState>;
  network: {
    allocatedIps: Set<string>;
    fdbEntries: VxlanEntry[];
  };
}

interface HostState {
  id: string;
  info: HostInfo;
  lastHeartbeat: Date;
  status: 'healthy' | 'unhealthy' | 'offline';
}

interface VMState {
  id: string;
  hostId: string;
  status: string;
  network: NetworkAllocation;
  createdAt: Date;
}
```

### Heartbeat Processing

```typescript
// apps/manager/src/services/cluster.service.ts

class ClusterService {
  private state: ClusterState;
  
  async processHeartbeat(hostId: string, data: HeartbeatData): Promise<void> {
    const host = this.state.hosts.get(hostId);
    if (!host) {
      throw new Error(`Unknown host: ${hostId}`);
    }
    
    // Update host state
    host.info.resources = data.resources;
    host.info.vms = data.vms;
    host.lastHeartbeat = new Date();
    host.status = 'healthy';
    
    // Reconcile VM state
    await this.reconcileVMs(hostId, data.vms);
  }
  
  // Background job: Check for unhealthy hosts
  async checkHostHealth(): Promise<void> {
    const now = Date.now();
    
    for (const [id, host] of this.state.hosts) {
      const age = now - host.lastHeartbeat.getTime();
      
      if (age > 30000) { // 30 seconds
        host.status = 'unhealthy';
        log.warn({ hostId: id, age }, 'Host unhealthy');
      }
      
      if (age > 60000) { // 60 seconds
        host.status = 'offline';
        log.error({ hostId: id, age }, 'Host offline');
        await this.handleHostOffline(id);
      }
    }
  }
  
  private async handleHostOffline(hostId: string): Promise<void> {
    // Mark all VMs on this host as error
    for (const [vmId, vm] of this.state.vms) {
      if (vm.hostId === hostId) {
        vm.status = 'error';
        // TODO: Notify users, attempt recovery
      }
    }
  }
}
```

---

## Traffic Routing

### Caddy Dynamic Routes

Manager's Caddy routes traffic to the correct host:

```
sandbox-abc.example.com → Host 1 (10.100.0.10:8080)
sandbox-def.example.com → Host 2 (10.100.0.20:8080)
sandbox-ghi.example.com → Host 3 (10.100.0.30:8080)
```

### Implementation

```typescript
// apps/manager/src/services/caddy.service.ts

async function addRoute(vm: VMState): Promise<void> {
  // Route through overlay network
  const route = {
    "@id": `sandbox-${vm.id}`,
    match: [{ host: [`sandbox-${vm.id}.${config.domain}`] }],
    handle: [{
      handler: "reverse_proxy",
      upstreams: [{ dial: `${vm.network.overlayIp}:8080` }],
    }],
  };
  
  await fetch(`${config.caddyAdmin}/config/apps/http/servers/srv0/routes`, {
    method: 'POST',
    body: JSON.stringify(route),
  });
}
```

### Alternative: Distributed Proxies

For higher scale, each host can run its own Caddy:

```
DNS Round-Robin: *.sandbox.example.com → [Host1, Host2, Host3]

Request → Host 1 Caddy → Local VM or Proxy to correct host
```

---

## Deployment

### Manager Setup

```bash
# 1. Install manager as before
frak-sandbox init --mode manager

# 2. Registry starts automatically on :5000
```

### Host Setup

```bash
# On each worker host

# 1. Download host agent
curl -L https://github.com/frak-id/frak-sandbox/releases/latest/download/host-agent-linux-x64 \
  -o /usr/local/bin/frak-host-agent
chmod +x /usr/local/bin/frak-host-agent

# 2. Register with manager
frak-host-agent join \
  --manager https://manager.example.com \
  --token ${JOIN_TOKEN}

# This will:
# - Configure VXLAN overlay
# - Setup LVM thin pool
# - Start host agent service
# - Register with manager
```

### Systemd Service (Host Agent)

```ini
# /etc/systemd/system/frak-host-agent.service
[Unit]
Description=FRAK Sandbox Host Agent
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frak-host-agent serve
Restart=always
RestartSec=5
Environment=MANAGER_URL=https://manager.example.com
Environment=HOST_ID=host-1
Environment=HOST_TOKEN=xxx

[Install]
WantedBy=multi-user.target
```

---

## Failure Handling

### Host Failure

```
1. Manager detects missing heartbeats (>60s)
2. Host marked offline
3. VMs on that host marked as "error"
4. User notified
5. (Future) Automatic VM migration to healthy host
```

### Network Partition

```
1. Host can't reach manager
2. VMs continue running (no immediate impact)
3. Host agent retries registration
4. On reconnect, state reconciled
```

### VM Failure

```
1. Host agent detects VM crash (process exit)
2. Reports to manager via heartbeat
3. Manager updates state
4. User notified
5. (Optional) Auto-restart if configured
```

---

## Monitoring

### Metrics Export

```typescript
// Prometheus metrics from manager
frak_hosts_total{status="healthy"} 3
frak_hosts_total{status="unhealthy"} 0
frak_hosts_total{status="offline"} 0

frak_vms_total{status="running"} 15
frak_vms_total{status="stopped"} 5

frak_host_cpu_usage{host="host-1"} 45
frak_host_memory_used_mb{host="host-1"} 32000
frak_host_disk_used_gb{host="host-1"} 250
```

### Dashboard Additions

- Cluster overview (hosts, total resources)
- Host list with health status
- VM placement visualization
- Network topology view

---

## Security Considerations

### Host Agent Authentication

```typescript
// JWT-based authentication
const token = jwt.sign(
  { hostId: 'host-1', role: 'agent' },
  config.jwtSecret,
  { expiresIn: '24h' }
);

// Host agent includes token in all requests
headers: {
  'Authorization': `Bearer ${token}`
}
```

### VXLAN Security

- Overlay network isolated from physical network
- VMs can only communicate within overlay
- (Future) WireGuard encryption for cross-host traffic

### Secrets in Transit

- All manager ↔ host communication over TLS
- Secrets encrypted before sending to hosts

---

## Phase 2.3: High Availability (Future)

### 3-Manager Raft Consensus

```
Manager 1 (Leader)  ←──→  Manager 2 (Follower)
        ↕                        ↕
        └────────────────────────┘
                    ↕
              Manager 3 (Follower)
```

**Implementation:** Use `hashicorp/raft` or `etcd` for state replication.

### Shared Storage for Live Migration

```
┌───────────────────────────────────────────┐
│            Ceph / NFS Cluster             │
│                                           │
│  ┌─────────────┐  ┌─────────────────────┐ │
│  │ OSD 1       │  │ OSD 2               │ │
│  └─────────────┘  └─────────────────────┘ │
└───────────────────────────────────────────┘
         │                 │
    ┌────┴────┐       ┌────┴────┐
    │ Host 1  │       │ Host 2  │
    │ (mount) │       │ (mount) │
    └─────────┘       └─────────┘
```

With shared storage, VMs can be live-migrated between hosts.
