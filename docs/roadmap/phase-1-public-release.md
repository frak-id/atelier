# Phase 1: Preparing Public Release

> Make L'atelier ready for open-source contributors and easy deployment

**Timeline:** 4-6 weeks
**Total Effort:** ~50-60 hours
**Status:** Planning

---

## Executive Summary

Phase 1 focuses on removing barriers to adoption:
1. **Code quality** - Fix architectural issues that make contribution difficult
2. **Onboarding** - Create guides for contributors and users
3. **Configuration** - Extract hardcoded values for any-domain deployment
4. **Setup simplicity** - One command to go from zero to running

---

## 1. Fix Circular Dependencies -> DONE

**Priority:** Critical
**Effort:** 8 hours
**Status:** Done

### Problem

The current `container.ts` creates circular dependencies:

```
container.ts imports from modules/*
     ↓
modules/* imports from container.ts
     ↓
Result: Tight coupling, hard to test, IDE issues
```

**Affected Files:**
- `apps/manager/src/container.ts`
- `apps/manager/src/modules/sandbox/sandbox.routes.ts`
- `apps/manager/src/modules/session-template/session-template.service.ts`
- `apps/manager/src/modules/task/task.service.ts`

### Solution

Implement constructor-based dependency injection:

```typescript
// BEFORE: Direct container import (circular)
// modules/sandbox/sandbox.service.ts
import { firecrackerClient, networkService } from "../../container.ts";

export const SandboxService = {
  async spawn() {
    await firecrackerClient.spawn(...);
  }
};

// AFTER: Constructor injection (clean)
// modules/sandbox/sandbox.service.ts
export function createSandboxService(deps: {
  firecracker: FirecrackerClient;
  network: NetworkService;
}) {
  return {
    async spawn() {
      await deps.firecracker.spawn(...);
    }
  };
}

// container.ts - Wire once at startup
const sandboxService = createSandboxService({
  firecracker: firecrackerClient,
  network: networkService,
});
```

### Tasks

- [ ] Audit all circular imports (`madge --circular`)
- [ ] Refactor services to accept dependencies via factory functions
- [ ] Update `container.ts` to wire dependencies at startup
- [ ] Verify no circular imports remain
- [ ] Update module documentation

### Acceptance Criteria

- [ ] `madge --circular src/` returns no results
- [ ] All services can be instantiated with mock dependencies
- [ ] Existing functionality unchanged (regression tests pass)

---

## 2. CONTRIBUTING.md Guide

**Priority:** Critical
**Effort:** 4 hours
**Owner:** TBD

### Problem

No guidance for potential contributors on:
- Development environment setup
- Code style expectations
- Pull request process
- Testing requirements

### Solution

Create comprehensive `CONTRIBUTING.md` at repository root.

### Content Outline

```markdown
# Contributing to L'atelier

## Quick Start (Development)
- Prerequisites (Bun, Docker)
- Clone and install
- Mock mode for local development
- Running tests

## Code Style
- Biome configuration (lint + format)
- TypeScript strict mode
- Service pattern (singleton objects)
- Module structure (routes -> service -> repository)

## Architecture Overview
- Link to docs/design-spec.md
- Component interaction diagram
- Key decisions and why

## Making Changes
- Branch naming convention
- Commit message format
- Pull request template
- Review process

## Testing
- Unit tests (Vitest)
- Integration tests
- How to run locally
- CI requirements

## Getting Help
- GitHub Discussions for questions
- Issues for bugs
- Discord/Slack for real-time chat

## Code of Conduct
- Be respectful
- Inclusive language
- Constructive feedback
```

### Tasks

- [ ] Write CONTRIBUTING.md with all sections
- [ ] Create PR template (`.github/PULL_REQUEST_TEMPLATE.md`)
- [ ] Create issue templates (bug, feature, question)
- [ ] Add CODE_OF_CONDUCT.md
- [ ] Update README.md with contributing section

### Acceptance Criteria

- [ ] New contributor can set up dev environment in <10 minutes
- [ ] Code style documented and enforceable via CI
- [ ] PR process is clear and documented

---

## 3. DevContainer Support

**Priority:** High
**Effort:** 8 hours
**Owner:** TBD

### Problem

Contributors can't easily set up a consistent development environment. The DevContainer spec is the industry standard (used by VS Code, Codespaces, DevPod).

### Solution

Add `.devcontainer/` configuration for instant dev environment.

### Implementation

```
.devcontainer/
├── devcontainer.json    # Main configuration
├── Dockerfile           # Custom image with all tools
└── docker-compose.yml   # Multi-container setup (if needed)
```

**devcontainer.json:**

```json
{
  "name": "L'atelier Dev",
  "build": {
    "dockerfile": "Dockerfile"
  },
  "features": {
    "ghcr.io/devcontainers/features/docker-in-docker:2": {},
    "ghcr.io/devcontainers/features/node:1": { "version": "22" }
  },
  "customizations": {
    "vscode": {
      "extensions": [
        "biomejs.biome",
        "oven.bun-vscode",
        "ms-vscode.vscode-typescript-next"
      ],
      "settings": {
        "editor.formatOnSave": true,
        "editor.defaultFormatter": "biomejs.biome"
      }
    }
  },
  "postCreateCommand": "bun install",
  "remoteUser": "node",
  "forwardPorts": [4000, 5173],
  "portsAttributes": {
    "4000": { "label": "Manager API" },
    "5173": { "label": "Dashboard" }
  }
}
```

**Dockerfile:**

```dockerfile
FROM mcr.microsoft.com/devcontainers/typescript-node:22

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install project dependencies
WORKDIR /workspace
COPY package.json bun.lock ./
RUN bun install

# Development tools
RUN apt-get update && apt-get install -y \
    jq \
    httpie \
    && rm -rf /var/lib/apt/lists/*
```

### Tasks

- [ ] Create `.devcontainer/devcontainer.json`
- [ ] Create `.devcontainer/Dockerfile`
- [ ] Test in VS Code Dev Containers
- [ ] Test in GitHub Codespaces
- [ ] Test in DevPod
- [ ] Document in CONTRIBUTING.md

### Acceptance Criteria

- [ ] `code .` → "Reopen in Container" works
- [ ] All tools available (Bun, Docker, Biome)
- [ ] `bun run dev` starts manager in mock mode
- [ ] Port forwarding works for API and dashboard

---

## 4. Extract Hardcoded Values

**Priority:** Critical
**Effort:** 6 hours
**Owner:** TBD

### Problem

The codebase contains hardcoded values that prevent deployment to different domains/networks:

| Value | Location | Issue |
|-------|----------|-------|
| `nivelais.com` | constants.ts, dashboard/api | Domain lock-in |
| `172.16.0.x` | constants.ts, provisioner | Network lock-in |
| `8.8.8.8` | sandbox.provisioner.ts | DNS lock-in |
| `frak-id` | config.ts | Org lock-in |
| Users list | config.ts | User lock-in |

### Solution

Move all environment-specific values to configuration with sensible defaults.

### Implementation

**1. Create unified config schema:**

```typescript
// packages/shared/src/config.schema.ts
import { Type, Static } from '@sinclair/typebox';

export const ConfigSchema = Type.Object({
  // Domains
  apiDomain: Type.String({ default: 'sandbox-api.localhost' }),
  dashboardDomain: Type.String({ default: 'sandbox-dash.localhost' }),
  sandboxDomainSuffix: Type.String({ default: 'localhost' }),
  sshDomain: Type.String({ default: 'ssh.localhost' }),

  // Network
  bridgeName: Type.String({ default: 'br0' }),
  bridgeIp: Type.String({ default: '172.16.0.1' }),
  bridgeCidr: Type.String({ default: '172.16.0.0/24' }),
  guestIpStart: Type.Number({ default: 10 }),
  dnsServers: Type.Array(Type.String(), { default: ['8.8.8.8', '8.8.4.4'] }),

  // Auth
  githubClientId: Type.String(),
  githubClientSecret: Type.String(),
  allowedOrg: Type.Optional(Type.String()),
  allowedUsers: Type.Optional(Type.Array(Type.String())),

  // Runtime
  mode: Type.Union([
    Type.Literal('production'),
    Type.Literal('mock')
  ], { default: 'production' }),
});

export type Config = Static<typeof ConfigSchema>;
```

**2. Load from environment + config file:**

```typescript
// apps/manager/src/shared/lib/config.ts
import { loadConfig } from '@frak/atelier-shared/config';

// Priority: ENV > config.yaml > defaults
export const config = loadConfig({
  envPrefix: 'ATELIER_',
  configFile: process.env.ATELIER_CONFIG || '/etc/atelier/config.yaml',
});
```

**3. Update constants.ts to use config:**

```typescript
// packages/shared/src/constants.ts
import { config } from './config';

export const NETWORK = {
  BRIDGE_NAME: config.bridgeName,
  BRIDGE_IP: config.bridgeIp,
  BRIDGE_CIDR: config.bridgeCidr,
  GUEST_IP_START: config.guestIpStart,
} as const;
```

**4. Example config file:**

```yaml
# /etc/atelier/config.yaml
apiDomain: sandbox-api.mycompany.com
dashboardDomain: sandbox-dash.mycompany.com
sandboxDomainSuffix: mycompany.com

network:
  bridgeIp: 10.0.0.1
  bridgeCidr: 10.0.0.0/24
  dnsServers:
    - 10.0.0.2  # Internal DNS

auth:
  allowedOrg: mycompany
```

### Files to Update

- [ ] `packages/shared/src/constants.ts` - Remove hardcoded values
- [ ] `apps/manager/src/shared/lib/config.ts` - Add config loading
- [ ] `apps/dashboard/src/api/client.ts` - Use runtime config
- [ ] `apps/manager/src/modules/sandbox/sandbox.provisioner.ts` - Use config for DNS
- [ ] `scripts/deploy.ts` - Use config instead of hardcoded replacements

### Tasks

- [ ] Create config schema with TypeBox
- [ ] Implement config loader (env + file + defaults)
- [ ] Update all files using hardcoded values
- [ ] Create example config file
- [ ] Update documentation with config options
- [ ] Add config validation at startup

### Acceptance Criteria

- [ ] Can deploy to any domain by setting `ATELIER_API_DOMAIN` etc.
- [ ] Can use different network ranges via config
- [ ] Startup fails fast with clear error if required config missing
- [ ] `atelier config validate` command works

---

## 5. Single `atelier init` Command

**Priority:** High
**Effort:** 12 hours
**Owner:** TBD

### Problem

Current setup requires 5+ separate commands and manual DNS configuration:

```bash
# Current flow (error-prone, time-consuming)
atelier init         # Full install
atelier firecracker  # Download binaries
atelier network      # Configure bridge
atelier storage      # Setup LVM
# ... manual DNS setup ...
# ... manual .env creation ...
atelier manager start
atelier images dev-base
```

### Solution

Single command that handles everything:

```bash
atelier init \
  --domain sandbox.example.com \
  --dns-provider cloudflare \
  --dns-token $CLOUDFLARE_TOKEN \
  --github-client-id $GITHUB_ID \
  --github-client-secret $GITHUB_SECRET \
  --storage-size 500GB \
  --storage-type loop
```

### Implementation

**1. New CLI command structure:**

```typescript
// apps/cli/src/commands/init.ts
import { intro, outro, spinner, confirm, select, text } from '@clack/prompts';

export async function init(options: InitOptions) {
  intro('L'atelier Initialization');

  // Phase 1: Validate prerequisites
  const s = spinner();
  s.start('Checking prerequisites...');
  await validatePrerequisites(); // KVM, disk space, network
  s.stop('Prerequisites OK');

  // Phase 2: Gather configuration (interactive if not provided)
  const config = await gatherConfig(options);

  // Phase 3: Execute setup phases
  const phases = [
    { name: 'Installing base packages', fn: () => baseSetup() },
    { name: 'Downloading Firecracker', fn: () => installFirecracker() },
    { name: 'Configuring network', fn: () => setupNetwork(config) },
    { name: 'Setting up storage', fn: () => setupStorage(config) },
    { name: 'Creating DNS records', fn: () => setupDns(config) },
    { name: 'Generating configuration', fn: () => generateConfig(config) },
    { name: 'Deploying services', fn: () => deployServices(config) },
    { name: 'Building base image', fn: () => buildImage('dev-base') },
    { name: 'Starting manager', fn: () => startManager() },
    { name: 'Running health checks', fn: () => healthCheck() },
  ];

  for (const phase of phases) {
    s.start(phase.name);
    try {
      await phase.fn();
      s.stop(`${phase.name} - Done`);
    } catch (error) {
      s.stop(`${phase.name} - Failed`);
      await rollback(phases.indexOf(phase));
      throw error;
    }
  }

  outro(`
    L'atelier is ready!

    Dashboard: https://${config.dashboardDomain}
    API:       https://${config.apiDomain}
    
    Next steps:
    1. Visit the dashboard to create your first sandbox
    2. Run 'atelier status' to check health
  `);
}
```

**2. DNS provider integrations:**

```typescript
// apps/cli/src/lib/dns-providers/cloudflare.ts
export async function createCloudflareRecord(config: DnsConfig) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/dns_records`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'A',
        name: `*.${config.subdomain}`,
        content: config.serverIp,
        proxied: false, // Important: Disable proxy for WebSocket
      }),
    }
  );
  // ...
}

// apps/cli/src/lib/dns-providers/route53.ts
export async function createRoute53Record(config: DnsConfig) {
  // AWS Route53 implementation
}

// apps/cli/src/lib/dns-providers/manual.ts
export function showManualDnsInstructions(config: DnsConfig) {
  console.log(`
    Please create the following DNS records:

    Type: A
    Name: *.${config.subdomain}
    Value: ${config.serverIp}
    TTL: 300

    Type: A
    Name: ${config.apiSubdomain}
    Value: ${config.serverIp}
    TTL: 300
  `);
}
```

**3. Prerequisites validation:**

```typescript
// apps/cli/src/lib/prerequisites.ts
export async function validatePrerequisites() {
  const checks = [
    {
      name: 'KVM support',
      check: () => access('/dev/kvm', constants.R_OK | constants.W_OK),
      fix: 'Enable VT-x/AMD-V in BIOS and ensure KVM module is loaded',
    },
    {
      name: 'Disk space (50GB minimum)',
      check: async () => {
        const { available } = await checkDiskSpace('/var/lib');
        return available > 50 * 1024 * 1024 * 1024;
      },
      fix: 'Free up disk space or use a different storage location',
    },
    {
      name: 'Network connectivity',
      check: () => fetch('https://github.com').then(() => true),
      fix: 'Ensure server has internet access',
    },
    {
      name: 'Root privileges',
      check: () => process.getuid() === 0,
      fix: 'Run with sudo or as root',
    },
  ];

  const results = await Promise.all(
    checks.map(async (c) => ({
      ...c,
      passed: await c.check().catch(() => false),
    }))
  );

  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    throw new PrerequisiteError(failed);
  }
}
```

**4. Rollback on failure:**

```typescript
// apps/cli/src/lib/rollback.ts
const rollbackActions = {
  network: async () => {
    await exec('ip link del br0', { throws: false });
    await exec('rm /etc/systemd/system/sandbox-network.service', { throws: false });
  },
  storage: async () => {
    await exec('lvremove -f sandbox-vg', { throws: false });
    await exec('vgremove sandbox-vg', { throws: false });
  },
  // ...
};

export async function rollback(upToPhase: number) {
  console.log('Rolling back changes...');
  // Reverse order rollback
}
```

### Tasks

- [ ] Create `init.ts` command with all phases
- [ ] Implement Cloudflare DNS provider
- [ ] Implement Route53 DNS provider
- [ ] Implement manual DNS instructions fallback
- [ ] Add prerequisite validation
- [ ] Add rollback on failure
- [ ] Add progress display with spinners
- [ ] Test on fresh Ubuntu 24.04
- [ ] Update documentation

### Acceptance Criteria

- [ ] Single command completes full setup in <15 minutes
- [ ] Clear error messages if prerequisites fail
- [ ] Rollback cleans up on failure
- [ ] Works with Cloudflare, Route53, or manual DNS
- [ ] Outputs next steps and URLs

---

## 6. Basic Test Suite

**Priority:** High
**Effort:** 10 hours
**Owner:** TBD

### Problem

No automated tests exist. This makes refactoring risky and contribution difficult.

### Solution

Add Vitest test suite with unit and integration tests.

### Implementation

```
apps/manager/
├── src/
│   └── modules/
│       └── sandbox/
│           ├── sandbox.service.ts
│           └── sandbox.service.test.ts  # NEW
├── vitest.config.ts                      # NEW
└── package.json                          # Add vitest
```

**Example test:**

```typescript
// apps/manager/src/modules/sandbox/sandbox.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSandboxService } from './sandbox.service';

describe('SandboxService', () => {
  const mockFirecracker = {
    spawn: vi.fn(),
    destroy: vi.fn(),
    getStatus: vi.fn(),
  };

  const mockNetwork = {
    allocateIp: vi.fn().mockResolvedValue('172.16.0.10'),
    createTap: vi.fn(),
    deleteTap: vi.fn(),
  };

  const mockStorage = {
    createVolume: vi.fn().mockResolvedValue('/dev/sandbox-vg/sandbox-abc'),
    deleteVolume: vi.fn(),
  };

  let service: ReturnType<typeof createSandboxService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = createSandboxService({
      firecracker: mockFirecracker,
      network: mockNetwork,
      storage: mockStorage,
    });
  });

  describe('spawn', () => {
    it('should allocate IP before creating VM', async () => {
      mockFirecracker.spawn.mockResolvedValue({ pid: 1234 });

      await service.spawn({ vcpus: 2, memoryMb: 2048 });

      expect(mockNetwork.allocateIp).toHaveBeenCalledBefore(
        mockFirecracker.spawn
      );
    });

    it('should clean up on failure', async () => {
      mockFirecracker.spawn.mockRejectedValue(new Error('VM failed'));

      await expect(service.spawn({})).rejects.toThrow('VM failed');

      expect(mockNetwork.deleteTap).toHaveBeenCalled();
      expect(mockStorage.deleteVolume).toHaveBeenCalled();
    });
  });
});
```

### Test Categories

| Category | Location | Coverage Goal |
|----------|----------|---------------|
| Unit tests | `*.test.ts` next to source | Services, utilities |
| Integration | `tests/integration/` | API endpoints |
| E2E | `tests/e2e/` | Full sandbox lifecycle |

### Tasks

- [ ] Add Vitest to manager package
- [ ] Create test utilities (mocks, fixtures)
- [ ] Write unit tests for core services
- [ ] Write integration tests for API routes
- [ ] Add coverage reporting
- [ ] Set minimum coverage threshold (60%)

### Acceptance Criteria

- [ ] `bun test` runs all tests
- [ ] Coverage report generated
- [ ] Tests pass in CI

---

## 7. GitHub Actions CI

**Priority:** High
**Effort:** 4 hours
**Owner:** TBD

### Problem

No automated quality checks on PRs.

### Solution

GitHub Actions workflow for lint, type-check, and test.

### Implementation

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run check

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run typecheck

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun test
      - uses: codecov/codecov-action@v4
        with:
          files: ./coverage/lcov.info

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run build:cli
      - uses: actions/upload-artifact@v4
        with:
          name: cli-linux-x64
          path: apps/cli/dist/atelier-linux-x64
```

### Tasks

- [ ] Create `.github/workflows/ci.yml`
- [ ] Add lint job
- [ ] Add typecheck job
- [ ] Add test job with coverage
- [ ] Add build job with artifact upload
- [ ] Add branch protection rules

### Acceptance Criteria

- [ ] All checks must pass before merge
- [ ] Coverage badge in README
- [ ] Build artifacts downloadable from Actions

---

## Timeline

```
Week 1-2:
├── Fix circular dependencies [8h]
├── Extract hardcoded values [6h]
└── CONTRIBUTING.md [4h]

Week 3-4:
├── DevContainer support [8h]
├── Basic test suite [10h]
└── GitHub Actions CI [4h]

Week 5-6:
├── Single init command [12h]
├── Documentation polish [4h]
└── Testing & bug fixes [4h]
```

---

## Definition of Done

Phase 1 is complete when:

- [ ] No circular dependencies (verified by tooling)
- [ ] CONTRIBUTING.md exists with complete guidance
- [ ] DevContainer works in VS Code, Codespaces, DevPod
- [ ] Can deploy to any domain via configuration
- [ ] `atelier init` completes full setup
- [ ] Test coverage > 60%
- [ ] CI passes on all PRs
- [ ] README updated with badges and quick start

---

## Next Steps

After Phase 1:
1. **Announce** - Blog post, Twitter, Hacker News
2. **Gather feedback** - GitHub Discussions, Discord
3. **Prioritize Phase 2** - Based on community input
4. **Celebrate** - First release!
