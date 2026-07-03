/**
 * The org toolbox — opencode + code-server as a BUILT toolset
 * (composed-prebuild-volumes.md §6 "kill shared-binaries"). Replaces the
 * global `shared-binaries` RWO PVC + populate Job: instead of a node-pinned
 * volume every sandbox pod mounts read-only, the binaries are a
 * content-addressed registry artifact the agent materializes into
 * `~/.local` at boot. Same versions/URLs/symlinks as the retired
 * `infra/k8s/v2/20-shared-binaries.yaml` Job, landing in the home instead of
 * `/opt/shared`.
 *
 * Content knowledge (versions, install commands) belongs here, not in
 * `runtime/` — the server's bootstrap just calls
 * `runtime.buildToolset(orgToolboxRequest)` with this request.
 */
import type { ToolsetBuildRequest } from "@atelier/spec";

const OPENCODE_VERSION = "1.17.4";
const CODE_SERVER_VERSION = "4.123.0";

export const ORG_TOOLBOX_NAME = "org-toolbox";

export const orgToolboxRequest: ToolsetBuildRequest = {
  name: ORG_TOOLBOX_NAME,
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
  metadata: { "atelier.dev/toolbox": "org" },
};
