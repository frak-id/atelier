# Infrastructure

Low-level services for K8s and external system integration.

## Services

| Service | Purpose | Protocol |
|---------|---------|----------|
| `KubeClient` | K8s API (pods, services, ingresses, jobs) | fetch()-based REST |
| `AgentClient` | Communicate with in-pod agent | HTTP over TCP |
| `RegistryService` | Verdaccio npm registry | HTTP |
| `CronService` | Scheduled jobs (prebuild staleness, self-heal) | In-process |

## KubeClient Note

Custom fetch()-based K8s REST client (~560 LOC). Uses `@kubernetes/client-node` is NOT used due to Bun compatibility issues. Supports kubeconfig and in-cluster auth.

## AgentClient Note

Uses standard fetch() over TCP to agent pods. Agent listens on port 9998 inside each sandbox pod.

For K8s resource builders, see `kubernetes/kube.resources.ts`.
