# Config Modeling Prior Art: Code-Sandbox & Dev-Environment Platforms

> **Purpose:** Understand how modern sandbox/dev-env platforms model "what goes in the box" — specifically how they escape a closed, typed feature schema and accept arbitrary setup. Synthesise design patterns and tradeoffs for a system that must host GUI servers, multi-skill agents, and environments exposing many dynamic ports.

---

## Per-System Analysis

### 1. E2B (Sandbox Templates)

#### Primitive unit of "what goes in the box"

E2B has two modes:

- **v1 (legacy):** A plain `Dockerfile` (or `e2b.Dockerfile`) plus an `e2b.toml` with a `start_cmd`. The CLI reads the Dockerfile, sends it to E2B's build service, and registers a template ID. Fully imperative — every `RUN apt install`, `RUN npm -g`, `COPY` etc. is exactly what you'd write in Docker.
- **v2 Build System (2024+):** A TypeScript/Python SDK-first approach. You compose a `Template` object by calling factory methods (`Template.fromBaseImage()`, `Template.fromDockerfile()`, `Template.fromBunImage()`) and chaining build steps. The SDK serialises this to E2B's build service; under the hood it still produces an OCI image. You can still call `fromDockerfile()` to inject raw Dockerfile content.

In both cases the primitive unit is **an OCI image built by an imperative build script**, but v2 wraps it in a fluent SDK API.

#### Handling things a typed schema can't enumerate

- Any `apt install`, `npm install -g`, custom daemons: put them in `RUN` instructions or in `run_commands` SDK calls — no schema restriction.
- Multiple long-lived processes: the `start_cmd` / `startCommand` is a single shell command, so you must use a process supervisor (e.g. `supervisord`, `s6`, a shell script) to fan out. E2B does not natively manage multi-process lifecycles.
- Dynamic ports: E2B exposes all TCP ports on the sandbox's public hostname; ports are discovered via the SDK (`sandbox.getHost(port)`) rather than pre-declared.
- The `ready_cmd` (a health-check command that must exit 0) is the only structured hook beyond `start_cmd`; everything else is inside the image.

#### Config layering (org / project / user)

E2B has **no formal layering**. There is one template = one image. If an org wants shared base tooling, they must either:
- Build a base image and reference it (`FROM org-base:latest`) in project Dockerfiles, or
- Use `Template.fromBaseImage("org-base")` in the SDK.

User-level personalisation (dotfiles, editor config) is not supported by E2B itself — callers inject it via the SDK (`sandbox.files.write()`, running commands after boot).

#### Lifecycle API separation

E2B cleanly separates:
- **Build time:** template build (OCI image creation, done once or on CI).
- **Runtime:** `Sandbox.create(templateId)` — a thin API (start, stop, exec, filesystem, port access). The runtime API is not "configuration"; it's process management.

**Sources:** [E2B Docs — Template Quickstart](https://e2b.dev/docs/template/quickstart), [E2B Build System 2.0 Blog](https://e2b.dev/blog/introducing-build-system-2-0), [E2B SDK Reference](https://e2b.dev/docs/sdk-reference/js-sdk/v2.10.3/template)

---

### 2. Modal (Image + Sandboxes)

#### Primitive unit

Modal's primitive is `modal.Image` — a **builder object composed by chaining method calls** in Python (or TypeScript). You start from a factory:

```python
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "git")
    .pip_install("fastapi", "httpx")
    .run_commands("npm install -g typescript")
    .copy_local_file("my.conf", "/etc/my.conf")
)
```

Each method appends an OCI layer. `run_commands()` accepts arbitrary shell strings. `dockerfile_commands()` accepts raw Dockerfile `RUN`/`COPY` directives. This is **imperative build script expressed as a fluent DSL**.

#### Handling things a typed schema can't enumerate

- `apt_install()`, `pip_install()`, `run_commands()` — any shell command is valid inside `run_commands`.
- `dockerfile_commands()` provides a Dockerfile escape hatch for anything the SDK methods don't model.
- `from_dockerfile()` lets you drop in a complete Dockerfile.
- Long-lived processes: `modal.Sandbox.create(image=..., *entrypoint_args)` starts the container with an arbitrary entrypoint. Multiple background processes need a supervisor inside the image.
- Ports: `Sandbox` constructor takes `encrypted_ports=[8080, 9090]` — a declared list, not a schema enum. The caller specifies them at create time. Dynamic port discovery is not natively supported; ports must be named at creation.

#### Config layering

Modal's unit of config is an `App` object, which groups `Function`s and `Sandbox`es. There is **no declarative org/project/user layering built in**. Teams compose their own layering by:
- Defining shared base images in a common module and importing them.
- Using Python functions/classes to wrap image construction with org-level defaults.

Modal Secrets are the layering mechanism for credentials: injected via `secrets=[modal.Secret.from_name("my-db")]`, which can be defined at the org scope in the Modal dashboard.

#### Lifecycle API separation

Modal is cleaner than most here:
- **Image** = build-time artifact (immutable, content-addressed, cached by layer).
- **App** = deployment unit (grouping of functions/sandboxes).
- **Sandbox** = runtime instance (thin process-like API: `exec`, `stdin`, `stdout`, `wait`, `terminate`).

These three layers are distinct Python objects with separate concerns.

**Sources:** [Modal Image Docs](https://modal.com/docs/guide/images), [Modal Sandbox Reference](https://modal.com/docs/reference/modal.Sandbox), [Modal Image API](https://modal.com/docs/reference/modal.Image)

---

### 3. Daytona

#### Primitive unit

Daytona's primitive is a **Workspace**, which contains one or more **Projects** (each backed by a Git repo). The project's "what goes in the box" is determined by the **builder mode** chosen at create time:

- **Auto (default):** Daytona detects `devcontainer.json` in the repo and uses that.
- **Devcontainer:** Explicitly points at a `devcontainer.json` path. Daytona builds the container image and pushes it to an associated registry.
- **Custom Image:** `--custom-image` flag — you name any OCI image.
- **None:** Falls back to a default base image.

The **Project Configuration** (introduced v0.24) is a saved preset of: repo URL + build mode + env vars. These configs are reusable across workspaces.

#### Handling things a typed schema can't enumerate

- Because Daytona defers to `devcontainer.json` (see §5 below) for build configuration, it inherits devcontainer's arbitrary-Dockerfile and Features composability.
- Env vars are managed via `daytona env` (user-level) and per-project config.
- Multiple ports: Daytona does not have its own port declaration scheme; it delegates to `devcontainer.json`'s `forwardPorts` or exposes ports via provider-level forwarding.
- Long-lived processes: delegated to `devcontainer.json` `postStartCommand` or process supervisors inside the image.

#### Config layering

Daytona has a **two-level** model:
- **User-level:** environment variables (`daytona env set`), dotfiles repo (applied on top of any workspace).
- **Project-level:** Project Configuration preset (image, build config, env vars, repo URL).

There is no org/team layer beyond access control. Daytona does not manage workspace templates at an admin/org scope — that is the gap the `Workspace Templates` issue (#362) was opened to address.

#### Lifecycle API separation

Daytona separates:
- **Provider:** the infrastructure adapter (Docker, AWS, GCP, K8s).
- **Builder:** image build pipeline (runs devcontainer build, pushes image).
- **Workspace/Project runtime:** start/stop/SSH.

This is a reasonable three-layer model but the config primitives (Project Configs) live at the "builder" layer with no strong schema — they are bags of settings.

**Sources:** [Daytona Project Config Blog](https://www.daytona.io/dotfiles/introducing-daytona-project-config-simplify-workspace-setup), [Daytona Issue #362](https://github.com/daytonaio/daytona/issues/362), [Daytona Issue #363](https://github.com/daytonaio/daytona/issues/363)

---

### 4. Coder (Terraform Templates)

#### Primitive unit

Coder's primitive is a **Template** — one or more Terraform `.tf` files. Coder runs `terraform apply` on every workspace create/start/stop. The Terraform files provision infrastructure (VMs, containers, k8s pods) and configure them. A typical template includes:

```hcl
resource "docker_container" "workspace" {
  image = docker_image.workspace.name
  # ...
}

resource "coder_agent" "main" {
  # installs the Coder agent into the container
  init_script = "..."
}
```

The `coder_agent` resource injects a startup script that installs the Coder agent, then runs arbitrary `startup_script` shell commands.

#### Handling things a typed schema can't enumerate

- **Any Terraform resource** can be used: EC2 instances, GCP VMs, k8s pods, Docker containers. There is no closed schema for "supported runtimes."
- `startup_script` in `coder_agent` is a shell string — arbitrary `apt install`, `npm install -g`, process launches, etc.
- Ports: `coder_app` resources declare app URLs/ports that appear in the Coder UI. But `coder_agent`'s built-in port forwarder also exposes any TCP port on demand (via `coder port-forward`). `coder_app` declarations are optional metadata for UI convenience, not a gating schema.
- Multiple long-lived processes: the `startup_script` (or a `postStart` hook) can launch `supervisord` or similar. Coder also supports `coder_app` resources pointing at different ports for each service.
- **Dynamic Parameters (v2.24+):** Terraform-computed form fields allow conditional workspace configs — e.g., `if region == "us-east" then use this AMI`. This replaces enum-style dropdowns with logic.

#### Config layering

This is Coder's strongest suit:

| Layer | Mechanism |
|---|---|
| **Platform/Org** | Admin sets Terraform template in Coder; all workspaces of that template share the base infra. |
| **Template** | `coder_parameter` inputs let users customise at create time (instance size, region, IDE). |
| **User** | Dotfiles repo (user sets once in account settings; all workspaces apply it via `coder_dotfiles` module). |
| **Runtime personalisation** | `startup_script` can read `data.coder_workspace.me.owner` to branch per-user logic. |

Organisations are first-class: each org gets its own templates, users, and provisioners.

#### Lifecycle API separation

Coder separates clearly:
- **Provisioner** (Terraform): creates/destroys infrastructure.
- **Agent** (runs inside workspace): manages IDE connections, port forwarding, metadata reporting.
- **Coder server** (control plane): schedules starts/stops, serves UI.

Terraform handles the "what" (image, resources); the agent handles the "how to connect." Template authors write Terraform; users and admins configure parameters.

**Sources:** [Coder Templates Docs](https://coder.com/docs/admin/templates/extending-templates), [Coder Template from Scratch](https://coder.com/docs/tutorials/template-from-scratch), [Coder Dynamic Parameters](https://coder.com/docs/admin/templates/extending-templates/dynamic-parameters.md), [Coder Organizations](https://coder.com/docs/admin/users/organizations)

---

### 5. Dev Containers (devcontainer spec)

#### Primitive unit

The devcontainer spec defines three composable layers:

1. **Base image** (`image:` or `build.dockerfile:`): either reference an OCI image or build one from a Dockerfile.
2. **Features** (`features:`): self-contained installation units, each with a `devcontainer-feature.json` (metadata), install script (`install.sh`), and optional default settings. Features are composable — you list N features and they are installed in dependency order.
3. **devcontainer.json properties**: `postCreateCommand`, `postStartCommand`, `postAttachCommand`, `onCreateCommand`, `updateContentCommand` — lifecycle hooks that run arbitrary shell commands.

```jsonc
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "20" },
    "ghcr.io/devcontainers/features/python:1": {}
  },
  "postCreateCommand": "npm install && pip install -r requirements.txt",
  "forwardPorts": [3000, 8080, 9000]
}
```

#### Handling things a typed schema can't enumerate

- Features' `install.sh` is a shell script — no schema restriction. A Feature that needs to write N config files, modify `/etc`, or install a binary from a custom URL can do so.
- `postCreateCommand` (and siblings) are shell strings or objects mapping names to shell strings — parallel execution of multiple hooks is supported via the object form.
- `forwardPorts` is a plain integer array — you list any ports; no enum.
- Multiple long-lived processes: `postStartCommand` runs on every container start; use a process supervisor or compose file.
- Features contribute their own lifecycle hooks (spec v0.5+): a Feature's `devcontainer-feature.json` can declare `postCreateCommand`, which is merged with the main config's hooks using additive merge (all run in order).

#### Config layering

The spec supports layering via:
- **Feature metadata:** each Feature can declare required env, settings, extensions, lifecycle hooks. These are merged with the user's `devcontainer.json`.
- **`devcontainer.json` merge order:** Feature-provided hooks are merged additively; user settings override Feature defaults.
- **Image labels:** built images store devcontainer metadata in OCI labels, allowing tools to reconstruct the effective config.
- **No formal org layer** in the spec itself. GitHub Codespaces and VS Code implement org-level "base images" via policy (e.g. a company image pinned in a repo template). The spec delegates org concerns to the platform.
- **`installsAfter` / `dependsOn` / `overrideFeatureInstallOrder`:** users can control install order when Features conflict.

#### Lifecycle API separation

The spec separates:
- **Build phase**: image + features installation → produces a container image.
- **Create phase**: `onCreateCommand` (runs once after creation).
- **Update phase**: `updateContentCommand` (re-runs when content changes, e.g. Codespaces Prebuild update).
- **Start phase**: `postStartCommand` (every start).
- **Attach phase**: `postAttachCommand` (every client connection).

This is the most explicit lifecycle model in the space.

**Sources:** [devcontainer Features spec](https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainer-features.md), [devcontainer reference spec](https://github.com/devcontainers/spec/blob/113500f4/docs/specs/devcontainer-reference.md), [VS Code Features blog](https://code.visualstudio.com/blogs/2022/09/15/dev-container-features), [Features lifecycle hooks issue](https://github.com/devcontainers/spec/blob/c95ffeed/docs/specs/features-contribute-lifecycle-scripts.md)

---

### 6. Gitpod Classic / Ona

#### Primitive unit

Gitpod's primitive is `.gitpod.yml`, a YAML file in the repo root with three top-level concerns:

```yaml
image:
  file: .gitpod.Dockerfile   # or: image: gitpod/workspace-full

tasks:
  - name: "Backend"
    init: npm install         # runs on prebuild
    command: npm run dev      # runs on workspace open

ports:
  - port: 3000
    onOpen: open-browser
  - port: 8080
    onOpen: notify

vscode:
  extensions:
    - ms-python.python
```

The `image` section points to either a public image or a repo-local Dockerfile (which can be arbitrary). There is no typed schema for what the image contains.

**Ona (Gitpod Flex, 2024+)** introduced `.ona/automations.yaml` alongside `devcontainer.json` support — it separates "tasks/services" from the container definition.

#### Handling things a typed schema can't enumerate

- Image is a Dockerfile — fully arbitrary.
- `tasks[].init`: shell string run once per prebuild.
- `tasks[].command`: shell string run on every workspace open (terminal tab per task).
- **Multiple processes via multiple tasks:** each task gets its own terminal. Gitpod is unique in that tasks are first-class parallel processes, not a single `CMD`. This is the cleanest native answer to "run 14 servers."
- `ports` array is open-ended: you list any port numbers, with per-port UI behavior.
- No schema for what runs in each task — any shell command.

#### Config layering

- **Project-level:** `.gitpod.yml` in repo (or subdirectory) defines all behavior.
- **User-level:** User environment variables (set in dashboard, available in all workspaces of that user). Editor preferences in user settings.
- **No org-wide template override** in Classic: org admins cannot inject config on top of `.gitpod.yml`.
- **Prebuilds:** the `init` task runs on prebuild, so workspace open only runs `command`. This is a performance optimization, not a config layer.

#### Lifecycle API separation

Gitpod's model:
- **Image build** (once, on prebuild or first open): Dockerfile → OCI image.
- **Init** (once per prebuild): `tasks[].init`.
- **Start** (every workspace open): `tasks[].command`.
- **Port behavior**: declarative metadata only; actual binding is done by processes in tasks.

The control plane (workspace scheduling, prebuild management) is separate from the task runner inside the workspace.

**Sources:** [Gitpod .gitpod.yml Reference (Ona)](https://ona.com/docs/classic/user/references/gitpod-yml), [Gitpod Workspace Configuration Overview (Ona)](https://ona.com/docs/classic/user/configure/workspaces/overview), [Gitpod Ports (Ona)](https://ona.com/docs/classic/user/configure/workspaces/ports), [Ona Lab 2 Config](https://ona.com/docs/workshops/lab-2-configuration)

---

### 7. Nix / Devbox / devenv

#### Primitive unit

The Nix ecosystem offers three related primitives:

**a) `shell.nix` / `flake.nix` (pure Nix):**
Declarative, purely functional: packages, env vars, and shell hooks expressed as Nix expressions. `pkgs.mkShell { buildInputs = [...]; shellHook = "..."; }`. The schema is Nix's type system — effectively arbitrary because `shellHook` is a string and `buildInputs` accepts any derivation.

**b) Devbox (`devbox.json`):**
A JSON config that names Nix packages by `name@version` strings. `devbox.json` supports:
- `packages`: list of Nix package refs.
- `shell.init_hook`: shell commands run on `devbox shell`.
- `shell.scripts`: named shell scripts.
- `services`: backed by **Process Compose** (since v0.4.7) — YAML describing named processes with commands, dependencies, healthchecks. Services are arbitrary shell commands.

**c) devenv (`devenv.nix`):**
A Nix module system wrapper. Modules for languages, processes, services. `processes.myservice.exec = "my-server --port 8080"` — arbitrary command. Process Compose is also used as the backend.

#### Handling things a typed schema can't enumerate

- Nix's `shellHook` and devbox's `init_hook` are raw shell strings — fully arbitrary.
- `services` in devbox/devenv are defined as named processes with an `exec` command — no schema restriction on what the process does.
- Multiple long-lived processes: devenv's `processes.*` and devbox's `services.*` are first-class; you name N processes and Process Compose manages them. This is the cleanest multi-process model.
- Ports: not explicitly declared in config; processes bind what they need. No platform-level port schema.
- `pkgs.fetchurl`, `pkgs.runCommand` etc. allow installing software not in nixpkgs (arbitrary download + build).

#### Config layering

Nix/devbox are **project-local** by design:
- **System-level:** NixOS system configuration (separate concern).
- **User-level:** `~/.config/nixpkgs/config.nix` or personal `home-manager` config.
- **Project-level:** `devbox.json` / `devenv.nix` / `shell.nix` in repo.
- Layering between levels is **composable in Nix** (import, override, extend) but not enforced — the user wires it.
- Devbox has no org/team layer; devenv modules can be composed but there's no access-controlled org layer.

#### Lifecycle API separation

- **Install time:** packages are installed into Nix store on `devbox shell` / `nix develop`.
- **Shell hook:** `init_hook` runs when entering the shell.
- **Process manager:** `devbox services start` / `devenv up` runs processes.
- No container lifecycle (no create/start/stop phases) unless you build a container with `devbox generate docker`.

**Sources:** [Nix dev environments wiki](https://wiki.nixos.org/wiki/Development_environment_with_nix-shell), [devbox.json Reference](https://www.jetify.com/docs/devbox/configuration), [Devbox Services 2.0](https://www.jetify.com/blog/devbox-0-4-7), [devenv flake integration](https://devenv.sh/guides/using-with-flakes/)

---

### 8. Firecracker-based Platforms (Fly.io Machines, AWS Lambda SnapStart, Warpbuild)

#### Primitive unit

Firecracker is a VMM — it provides the isolation layer (microVMs). Platforms built on Firecracker expose their own configuration models layered on top:

**Fly.io Machines API:**
The primitive unit is a **Machine** — a Firecracker microVM configured via JSON:

```json
{
  "config": {
    "image": "registry.fly.io/my-app:latest",
    "guest": { "cpu_kind": "shared", "cpus": 2, "memory_mb": 1024 },
    "env": { "MY_VAR": "value" },
    "services": [
      { "ports": [{"port": 443, "handlers": ["tls", "http"]}], "internal_port": 8080 }
    ],
    "processes": [
      { "name": "app", "entrypoint": ["/usr/local/bin/server"], "cmd": ["--port", "8080"] },
      { "name": "worker", "entrypoint": ["/usr/local/bin/worker"] }
    ]
  }
}
```

The image is any OCI image — arbitrary content. The `processes` array supports multiple named processes in one Machine (each gets its own container within the shared network namespace — similar to a Pod). `services[].internal_port` is a plain integer, no enum.

**AWS Firecracker (Lambda/Fargate internals):** Not directly user-configurable at the Firecracker level — the platform wraps it in a function or task API. The user provides a container image or deployment package; the platform handles the VMM config.

**Kata Containers:** Firecracker used as the hypervisor backend for Kata; config is a TOML file (kernel path, rootfs, vCPU count, memory). This is operator-level config, not user-level.

#### Handling things a typed schema can't enumerate

At the Firecracker level, there is **no typed schema for workload content** — the microVM boots whatever is in the root filesystem (OCI image). Arbitrary packages, processes, ports are all in the image and the `config.processes` array.

Fly.io's `services` array lists ports with handlers (TLS, HTTP, TCP) — you add as many as needed. `processes` array runs as many background processes as needed. No closed list.

#### Config layering

Fly.io's layering:
- **App-level:** `fly.toml` (declarative config for services, mounts, env). Deployed to all Machines in the app.
- **Machine-level:** individual Machine config (can override image, processes, resources per Machine).
- **No user-level personalisation** layer (not a dev environment platform — it's a compute platform).

#### Lifecycle API separation

Fly.io explicitly separates:
- **Image** (build-time artifact, any OCI image).
- **Machine config** (runtime parameters: guest resources, env, services, processes).
- **Machines API** (CRUD: create, start, stop, destroy, update, signal, exec).
- **flyctl / `fly.toml`** (higher-level deploy abstraction over the Machines API).

This is the cleanest separation in the group: the Machines API is a pure compute primitive; `fly.toml` is the policy/composition layer.

**Sources:** [Fly.io Machines API Docs](https://fly.io/docs/machines/guides-examples/managing-machines-with-the-api/), [Fly.io Machine Runtime Env](https://fly.io/docs/machines/runtime-environment/), [Fly.io Multi-container Machines](https://fly.io/docs/machines/guides-examples/multi-container-machines/), [Firecracker design doc](https://github.com/firecracker-microvm/firecracker/blob/becc4b74/docs/design.md)

---

## Summary Table

| System | Primitive Unit | Arbitrary Config Escape Hatch | Multi-Process | Dynamic Ports | Org/Team Layer | User Layer | Lifecycle API Separation |
|---|---|---|---|---|---|---|---|
| **E2B** | OCI image (Dockerfile or SDK builder) | Any `RUN` in Dockerfile; `run_commands` in SDK | Supervisor inside image; single `start_cmd` | Any port via `sandbox.getHost(n)` — no pre-declaration needed | None | None (inject via SDK at runtime) | Build template vs. `Sandbox` runtime API |
| **Modal** | `modal.Image` fluent builder chain | `run_commands("any shell")`, `dockerfile_commands()`, `from_dockerfile()` | Supervisor inside image; single entrypoint | `encrypted_ports=[...]` declared at `Sandbox.create()` — open list | None (Python import convention) | None | `Image` (build) vs. `App` (deploy) vs. `Sandbox` (runtime) |
| **Daytona** | Workspace + Project Config preset | Devcontainer `install.sh` or custom image | Delegated to devcontainer `postStartCommand` | Delegated to devcontainer `forwardPorts` | None (planned) | `daytona env` + dotfiles repo | Provider (infra) vs. Builder (image) vs. Workspace runtime |
| **Coder** | Terraform `.tf` files | `startup_script` (shell string); any Terraform resource | Multiple `coder_app` resources; `supervisord` in script | `coder_app` (UI metadata); `coder port-forward` (any port on demand) | Org scope, template RBAC | Dotfiles repo; `coder_parameter` per-user inputs | Provisioner (Terraform) vs. Agent (in-workspace) vs. Control plane |
| **devcontainers** | Base image + Features list + lifecycle hooks | Feature `install.sh`; `postCreateCommand`; Dockerfile | `postStartCommand` (parallel via object form) | `forwardPorts: [...]` — open integer array | Platform-implemented (not in spec) | `postAttachCommand`; platform dotfiles | Build → onCreate → updateContent → postStart → postAttach |
| **Gitpod / Ona** | `.gitpod.yml` (image + tasks + ports) | Dockerfile for image; task `command` is shell string | Multiple tasks = multiple terminals (native!) | `ports[].port` — open integer list | None in Classic; Ona adds org runners | User env vars; user settings | Image build (prebuild) vs. init (prebuild) vs. start (open) |
| **Nix / devbox** | `shell.nix` / `devbox.json` / `devenv.nix` | `shellHook`/`init_hook` (shell); `services[].exec` (arbitrary command) | `devenv processes.*` / `devbox services` via Process Compose — native! | None (processes bind what they need; no platform port schema) | None | User `home-manager`; personal nix config | Install (nix store) vs. shell hook vs. process manager |
| **Firecracker / Fly.io** | Machine = microVM + OCI image + JSON config | Any OCI image content; `processes[].entrypoint` | `processes` array (multi-process native in Fly.io) | `services[].internal_port` — open integer; add as many as needed | App-level `fly.toml` | None (compute platform) | Image vs. Machine config vs. Machines API vs. `fly.toml` |

---

## Synthesis: Dominant Configuration-Modeling Patterns

### Pattern A: Imperative Build Script (Shell-as-Config)

**Examples:** E2B (Dockerfile), Modal (`run_commands`), Coder (`startup_script`), Gitpod (task `command`), devcontainer (lifecycle hooks).

**Structure:** The configuration primitive is a shell string or script. The platform defines the *when* (build, create, start, attach) and the *where* (which user, which directory), but the *what* is untyped.

**How it handles "what a schema can't enumerate":** Perfectly — there is no schema. `apt install anything`, write any config file, run any daemon. The escape hatch is the escape hatch.

**Tradeoffs:**
- ✅ Maximum expressiveness. No schema divergence risk.
- ✅ Matches developer intuition (bash is universal).
- ❌ No platform understanding of what is installed. No dependency resolution, no conflict detection, no introspection.
- ❌ Reproducibility depends entirely on author discipline (pinned versions, idempotency).
- ❌ Composition is copy-paste or shell-library conventions, not typed.

### Pattern B: Declarative Layer/Feature Composition

**Examples:** devcontainers Features, Nix/devenv modules, Modal `Image` fluent builder.

**Structure:** A set of named, versioned, self-contained units that each declare what they install and their hooks. A config file composes them: `features: { "ghcr.io/feat/node": { "version": "20" } }`. The platform merges them, resolves order, and executes each unit's install script.

**How it handles "what a schema can't enumerate":** The *units themselves* are shell scripts (Pattern A inside the Feature). The composition layer is declarative, but the leaf is imperative. So you get composability + arbitrary execution.

**Tradeoffs:**
- ✅ Composable and shareable (OCI registry for devcontainer Features; nixpkgs for Nix packages).
- ✅ Platform can introspect which Features are installed (for UI, conflict warnings, prebuild fingerprinting).
- ✅ Lifecycle hooks are additive-merged, so Features contribute their own `postCreateCommand` without conflicting.
- ❌ Install order can cause conflicts (mitigated by `dependsOn`/`installsAfter`).
- ❌ Authoring a Feature is more work than writing a shell script.
- ❌ Not all workloads decompose cleanly into Features (a custom GUI server with 10 config files is not a natural Feature).

### Pattern C: Infrastructure-as-Code Resource Graph (Terraform-style)

**Examples:** Coder (Terraform templates), Fly.io (Machines API + `fly.toml`).

**Structure:** Config is a graph of typed resources (VMs, containers, apps, networks, secrets). The platform applies the graph (create/update/destroy). Lifecycle is managed by the platform's state machine. Shell commands appear at leaves (`startup_script`, `entrypoint`).

**How it handles "what a schema can't enumerate":** Through the shell escape hatch at the leaves, and through the open-endedness of the resource graph (any Terraform provider resource is valid).

**Tradeoffs:**
- ✅ Best org/team/project layering: Terraform modules compose cleanly; Coder adds per-user parameters and dotfiles on top.
- ✅ Infrastructure is explicitly modeled (instance type, region, GPU, secrets) — composable at the infra level.
- ✅ Idempotent and diff-able: the platform tracks state and applies changes.
- ❌ Higher authoring complexity (Terraform HCL is unfamiliar to many devs).
- ❌ Slow feedback loop (Terraform apply takes time vs. a shell script).
- ❌ Config inside the workspace (`startup_script`) is still untyped shell.

---

## Which Pattern Best Supports "Accept ANY Config"?

**The answer is Pattern A (imperative shell), but composed via Pattern B's layering model.**

For the use cases described — a harness with its own GUI server, an agent with a dozen skills + MCP servers, a workspace with 14 dev servers to expose — the requirements are:

1. **Arbitrary system installs** → shell scripts, always.
2. **Multiple long-lived processes** → native process management (Gitpod tasks, devenv processes, Fly.io processes array) beats shell supervisors started from a single `CMD`.
3. **N dynamic ports** → open-ended integer list (not an enum), with optional metadata per port.
4. **No closed schema** → Platform must not require declaring "capabilities" — it must accept arbitrary OCI images and arbitrary startup commands.

### Recommended Design Pattern: "Escape-Hatch First, Schema as Optional Metadata"

The platforms that handle the hardest cases best (Gitpod tasks, devenv processes, Fly.io multi-process Machines, Coder `startup_script`) share a design principle:

> **The platform owns lifecycle phase scheduling; the user owns all content within each phase.**

Concretely:

| Platform layer | What it types | What it leaves untyped |
|---|---|---|
| **Machine/sandbox API** | CPU, memory, OCI image reference, named processes (as string arrays), port list (as integers), env vars (as string map) | Content of the image, content of each process entrypoint |
| **Composition/policy layer** | Named phases (build, create, start, attach), named processes, named ports (with optional metadata: label, protocol, visibility) | What runs in each phase/process |
| **Feature/module layer (optional)** | Feature ID, version, typed options (small set) | `install.sh` is arbitrary shell |

The critical insight from devcontainers is **additive lifecycle hook merging**: multiple composition units (Features, modules, user hooks) all contribute to the same lifecycle phase without overwriting each other. This is the mechanism that allows "a harness + 12 MCP servers + 14 dev servers" to each register their startup commands without any of them needing to know about the others.

**Anti-pattern to avoid:** A closed feature schema (enum of "supported runtimes" or "supported integrations"). Every platform that has tried this (early Gitpod custom images vs. `gitpod/workspace-full`, early E2B template types) eventually added a Dockerfile/shell escape hatch and that became the dominant path. Design for the escape hatch from day one.

---

## Key Citations

| Platform | Primary Source |
|---|---|
| E2B | https://e2b.dev/docs/template/quickstart, https://e2b.dev/blog/introducing-build-system-2-0 |
| Modal | https://modal.com/docs/guide/images, https://modal.com/docs/reference/modal.Sandbox |
| Daytona | https://www.daytona.io/dotfiles/introducing-daytona-project-config-simplify-workspace-setup, https://github.com/daytonaio/daytona/issues/362 |
| Coder | https://coder.com/docs/admin/templates/extending-templates, https://coder.com/docs/tutorials/template-from-scratch |
| devcontainers | https://github.com/devcontainers/spec/blob/main/docs/specs/devcontainer-features.md, https://github.com/devcontainers/spec/blob/113500f4/docs/specs/devcontainer-reference.md |
| Gitpod / Ona | https://ona.com/docs/classic/user/references/gitpod-yml, https://ona.com/docs/classic/user/configure/workspaces/overview |
| Nix / devbox | https://wiki.nixos.org/wiki/Development_environment_with_nix-shell, https://www.jetify.com/docs/devbox/configuration, https://www.jetify.com/blog/devbox-0-4-7 |
| Firecracker / Fly.io | https://fly.io/docs/machines/guides-examples/managing-machines-with-the-api/, https://github.com/firecracker-microvm/firecracker/blob/becc4b74/docs/design.md |
