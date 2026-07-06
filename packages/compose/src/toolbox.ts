/**
 * The default org toolbox — opencode + code-server as a BUILT toolset
 * (composed-prebuild-volumes.md §6 "kill shared-binaries"). Seeded once per
 * org (per-org-toolboxes.md §3) rather than injected unconditionally: the
 * binaries are a content-addressed registry artifact the agent materializes
 * into `~/.local` at boot, replacing the retired node-pinned
 * `infra/k8s/v2/20-shared-binaries.yaml` shared-binaries PVC + populate Job.
 *
 * Content knowledge (versions, install commands) belongs here, not in
 * `runtime/` — control seeds this as an org's `ToolboxConfig`, and the api/
 * seam later turns auto-inject configs into `runtime.buildToolset()` requests.
 */
import type { ToolboxConfigInput } from "@atelier/spec";

const OPENCODE_VERSION = "1.17.4";
const CODE_SERVER_VERSION = "4.123.0";

export const DEFAULT_TOOLBOX: ToolboxConfigInput = {
  slug: "org-toolbox",
  description: "opencode + code-server (default)",
  // The default org toolbox also owns the opencode harness: a spawn that
  // doesn't declare its own harness inherits opencode from this baseline.
  harness: "opencode",
  build: [
    "mkdir -p ~/.local/bin ~/.local/share/opencode ~/.local/share/code-server",
    `curl -fsSL -o /tmp/opencode.tar.gz "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64-baseline.tar.gz"`,
    "tar -xzf /tmp/opencode.tar.gz -C ~/.local/share/opencode && rm -f /tmp/opencode.tar.gz",
    "ln -sf ~/.local/share/opencode/opencode ~/.local/bin/opencode",
    `curl -fsSL -o /tmp/code-server.tar.gz "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz"`,
    "tar -xzf /tmp/code-server.tar.gz -C ~/.local/share/code-server --strip-components=1 && rm -f /tmp/code-server.tar.gz",
    "ln -sf ~/.local/share/code-server/bin/code-server ~/.local/bin/code-server",
  ],
  paths: [
    "~/.local/bin/opencode",
    "~/.local/bin/code-server",
    "~/.local/share/opencode",
    "~/.local/share/code-server",
  ],
  autoInject: true,
};
