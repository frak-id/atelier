import type { SandboxConfig } from "@frak/atelier-shared";
import {
  buildToolIngress,
  type KubeResource,
  toolIngressName as kubeToolIngressName,
  toolHost,
} from "../../infrastructure/kubernetes/index.ts";
import { resolveHarness } from "../../shared/agent/harness-adapter.ts";
import { config } from "../../shared/lib/config.ts";

/**
 * Built-in tool registry.
 *
 * Tools are data, not code. Each tool declares the agent services it runs, an
 * optional HTTP exposure (ingress + dashboard URL), and a start policy. The
 * orchestrator/K8s layers iterate this registry instead of hand-wiring each
 * tool, so adding/removing a tool is a single entry here.
 *
 * The coding-agent harness is the one core/critical tool: it is always present
 * and always started, even for workspaceless sandboxes, and its failure aborts
 * the spawn (see `criticalServiceNames()`). Everything else (vscode, terminal,
 * the browser/VNC stack) is generic and could later be made user-configurable.
 * Tools declare `core`/`critical` in data, so no call site special-cases a
 * particular harness slug.
 *
 * NOTE: the in-pod agent's autostart loop is disabled (see agent `main.rs`),
 * so service entries carry no start flag — the manager decides what to start
 * via `bootServiceNames()` / `coreServiceNames()`.
 */

type ServiceEntry = SandboxConfig["services"][string];

/** Runtime values needed to materialize a tool's service commands. */
export interface ToolContext {
  workspaceDir: string;
  dashboardDomain: string;
  /** Basic-auth password for the harness's HTTP surface (if it has one). */
  agentPassword?: string;
  /** Workspace-mode env forwarded into the harness process. */
  agentEnv?: Record<string, string>;
  dev?: { command: string; workdir?: string; env?: Record<string, string> };
}

export interface ToolExposure {
  /** Subdomain prefix → `${subdomain}-${sandboxId}.${dashboardDomain}`. */
  subdomain: string;
  /** In-pod service port the ingress targets. */
  port: number;
  /** Ingress annotations (forward-auth, header injection, …). */
  annotations?: Record<string, string>;
}

export type ToolStart = "boot" | "lazy";
export type ToolManagedBy = "agent" | "manager";

export interface ToolDefinition {
  slug: string;
  name: string;
  /** Core tools are always present and started, even without a workspace. */
  core?: boolean;
  /**
   * Critical tools block the user-facing flow: if one of their services fails
   * to start the spawn is aborted (see `startServices`). The active harness is
   * critical; everything else is best-effort.
   */
  critical?: boolean;
  /** `boot` = ingress + service started at spawn; `lazy` = on demand. */
  start: ToolStart;
  /**
   * Who drives the tool's services. `agent` tools are ensured in-pod by the
   * agent itself (e.g. terminal) and contribute nothing for the manager to
   * start. Defaults to `manager`.
   */
  managedBy?: ToolManagedBy;
  /** Delay (ms) between sequential service starts (ordered multi-service tools). */
  startDelayMs?: number;
  /** Optional HTTP exposure (ingress + dashboard URL). */
  exposure?: ToolExposure;
  /** Agent service entries this tool contributes to `config.json`. */
  buildServices: (ctx: ToolContext) => Record<string, ServiceEntry>;
  /** Service names the manager starts when this tool is activated. */
  autoStartServices: string[];
}

const TLS_SECRET_NAME = "atelier-sandbox-wildcard-tls";

export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    slug: "vscode",
    name: "VS Code",
    start: "lazy",
    exposure: {
      subdomain: "vscode",
      port: config.ports.vscode,
      annotations: config.kubernetes.vsCodeIngressAnnotations,
    },
    autoStartServices: ["vscode"],
    buildServices: (ctx) => {
      const port = config.ports.vscode;
      return {
        vscode: {
          port,
          command: `/opt/shared/bin/code-server --bind-addr 0.0.0.0:${port} --auth none --disable-telemetry ${ctx.workspaceDir}`,
          user: "dev",
        },
      };
    },
  },
  {
    slug: "opencode",
    name: "OpenCode",
    core: true,
    critical: true,
    start: "boot",
    exposure: {
      subdomain: "opencode",
      port: config.ports.opencode,
      annotations: config.kubernetes.openCodeIngressAnnotations,
    },
    autoStartServices: ["opencode"],
    buildServices: (ctx) => {
      const port = config.ports.opencode;
      return {
        opencode: {
          port,
          command: `cd ${ctx.workspaceDir} && /opt/shared/bin/opencode serve --hostname 0.0.0.0 --port ${port} --cors https://${ctx.dashboardDomain}`,
          user: "dev",
          env: {
            ...(ctx.agentPassword && {
              OPENCODE_SERVER_PASSWORD: ctx.agentPassword,
            }),
            // Forwarded from the local opencode-atelier plugin. Anything
            // missing here leaves the remote opencode in non-workspace mode.
            ...(ctx.agentEnv ?? {}),
          },
        },
      };
    },
  },
  {
    slug: "terminal",
    name: "Terminal",
    start: "boot",
    managedBy: "agent",
    autoStartServices: [],
    buildServices: () => ({
      terminal: {
        port: config.ports.terminal,
        enabled: true,
      },
    }),
  },
  {
    // ACP stdio<->WebSocket bridge. The in-pod agent (acp.rs) starts the WS
    // listener from this entry and spawns the harness per session on demand,
    // so there's nothing for the manager to start (managedBy: agent). The
    // command/user/workdir/env here are the per-session harness launch
    // template the bridge reads; harness-driven so swapping the agent is an
    // adapter change, not a registry edit.
    slug: "acp",
    name: "ACP Bridge",
    start: "boot",
    managedBy: "agent",
    autoStartServices: [],
    buildServices: (ctx) => {
      const harness = resolveHarness(undefined);
      return {
        acp: {
          port: config.ports.acp,
          enabled: true,
          command: harness.acpCommand(),
          user: "dev",
          workdir: ctx.workspaceDir,
          ...(ctx.agentEnv && { env: ctx.agentEnv }),
        },
      };
    },
  },
  {
    slug: "browser",
    name: "Browser",
    start: "lazy",
    startDelayMs: 500,
    exposure: {
      subdomain: "browser",
      port: config.ports.browser,
      annotations: config.kubernetes.vsCodeIngressAnnotations,
    },
    autoStartServices: ["kasmvnc", "openbox", "chromium"],
    buildServices: () => {
      const port = config.ports.browser;
      return {
        kasmvnc: {
          port,
          command: `Xvnc :99 -geometry 1280x900 -depth 24 -websocketPort ${port} -SecurityTypes None -AlwaysShared -AcceptSetDesktopSize -DisableBasicAuth -UseIPv6 0 -interface 0.0.0.0 -httpd /usr/share/kasmvnc/www -FrameRate 60 -DynamicQualityMin 7 -DynamicQualityMax 9 -RectThreads 0 -CompareFB 2 -DetectScrolling -sslOnly 0`,
          user: "root",
        },
        openbox: {
          command: "openbox",
          user: "dev",
          env: { DISPLAY: ":99" },
        },
        chromium: {
          command:
            "chromium --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage --no-first-run --disable-session-crashed-bubble --disable-infobars --disable-translate --disable-features=TranslateUI --password-store=basic --disable-background-networking --disable-sync --disable-extensions --disable-default-apps --disable-breakpad --disable-component-extensions-with-background-pages --disable-background-timer-throttling --force-device-scale-factor=1 --disable-lcd-text --renderer-process-limit=2 --disk-cache-size=104857600 --user-data-dir=/tmp/chromium-profile about:blank",
          user: "dev",
          env: { DISPLAY: ":99" },
        },
      };
    },
  },
  {
    slug: "dev",
    name: "Dev Server",
    start: "lazy",
    exposure: {
      subdomain: "dev",
      port: config.ports.dev,
    },
    autoStartServices: ["dev"],
    buildServices: (ctx): Record<string, ServiceEntry> => {
      if (!ctx.dev) return {};
      return {
        dev: {
          port: config.ports.devApp,
          command: ctx.dev.command,
          user: "dev",
          workdir: ctx.dev.workdir ?? ctx.workspaceDir,
          // User env first, then the forwarder contract overrides it: a
          // user-set PORT would bind the dev server off the port the forwarder
          // targets, silently breaking the public URL.
          env: {
            ...(ctx.dev.env ?? {}),
            PORT: String(config.ports.devApp),
            __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: `.${config.domain.baseDomain}`,
          },
        },
      };
    },
  },
];

export function getTool(slug: string): ToolDefinition | undefined {
  return BUILTIN_TOOLS.find((tool) => tool.slug === slug);
}

export interface ToolInfo {
  slug: string;
  name: string;
  start: ToolStart;
  core: boolean;
  exposed: boolean;
  url?: string;
  services: string[];
}

export function listToolInfos(sandboxId: string): ToolInfo[] {
  return BUILTIN_TOOLS.map((tool) => ({
    slug: tool.slug,
    name: tool.name,
    start: tool.start,
    core: !!tool.core,
    exposed: !!tool.exposure,
    url: toolUrl(tool.slug, sandboxId),
    services: tool.autoStartServices,
  }));
}

/** Merge every tool's agent services into the sandbox `config.json` map. */
export function buildToolServices(ctx: ToolContext): SandboxConfig["services"] {
  const services: SandboxConfig["services"] = {};
  for (const tool of BUILTIN_TOOLS) {
    Object.assign(services, tool.buildServices(ctx));
  }
  return services;
}

/** Service names the manager starts at spawn for a full (workspace) sandbox. */
export function bootServiceNames(): string[] {
  return BUILTIN_TOOLS.filter((tool) => tool.start === "boot").flatMap(
    (tool) => tool.autoStartServices,
  );
}

/** Service names started for a workspaceless sandbox (core tools only). */
export function coreServiceNames(): string[] {
  return BUILTIN_TOOLS.filter((tool) => tool.core).flatMap(
    (tool) => tool.autoStartServices,
  );
}

/**
 * Service names whose start failure must abort the spawn. Data-driven so no
 * call site hardcodes a harness slug (see `startServices` in guest-base).
 */
export function criticalServiceNames(): string[] {
  return BUILTIN_TOOLS.filter((tool) => tool.critical).flatMap(
    (tool) => tool.autoStartServices,
  );
}

function ingressFor(
  tool: ToolDefinition,
  sandboxId: string,
): KubeResource | undefined {
  const exposure = tool.exposure;
  if (!exposure) return undefined;
  return buildToolIngress({
    sandboxId,
    subdomain: exposure.subdomain,
    port: exposure.port,
    sandboxDomain: config.domain.dashboard,
    ingressClassName: config.kubernetes.ingressClassName || undefined,
    annotations: exposure.annotations,
    tlsSecretName: TLS_SECRET_NAME,
  });
}

// Pre-registered for every exposed tool at spawn, even lazy ones: an ingress
// with no running backend just 502s, so pre-creating it removes ingress
// propagation latency from the lazy start path at no cost.
export function buildToolIngressResources(sandboxId: string): KubeResource[] {
  return BUILTIN_TOOLS.flatMap((tool) => {
    const ingress = ingressFor(tool, sandboxId);
    return ingress ? [ingress] : [];
  });
}

export function toolIngressNames(sandboxId: string): string[] {
  return BUILTIN_TOOLS.flatMap((tool) =>
    tool.exposure
      ? [kubeToolIngressName(tool.exposure.subdomain, sandboxId)]
      : [],
  );
}

/** Public HTTPS URL for an exposed tool. */
export function toolUrl(slug: string, sandboxId: string): string | undefined {
  const tool = getTool(slug);
  if (!tool?.exposure) return undefined;
  return `https://${toolHost(tool.exposure.subdomain, sandboxId, config.domain.dashboard)}`;
}
