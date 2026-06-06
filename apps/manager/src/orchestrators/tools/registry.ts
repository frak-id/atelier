import type { SandboxConfig } from "@frak/atelier-shared";
import {
  buildToolIngress,
  type KubeResource,
  toolIngressName as kubeToolIngressName,
  toolHost,
} from "../../infrastructure/kubernetes/index.ts";
import { config } from "../../shared/lib/config.ts";

/**
 * Built-in tool registry.
 *
 * Tools are data, not code. Each tool declares the agent services it runs, an
 * optional HTTP exposure (ingress + dashboard URL), and a start policy. The
 * orchestrator/K8s layers iterate this registry instead of hand-wiring each
 * tool, so adding/removing a tool is a single entry here.
 *
 * `opencode` is the one core tool: it is always present and always started,
 * even for workspaceless sandboxes. Everything else (vscode, terminal, the
 * browser/VNC stack) is generic and could later be made user-configurable.
 *
 * NOTE: the in-pod agent does NOT act on the `autoStart` flag (its autostart
 * loop is disabled — see agent `main.rs`). The manager decides what to start
 * via `bootServiceNames()` / `coreServiceNames()`; `autoStart` is kept on the
 * service entry purely as descriptive metadata.
 */

type ServiceEntry = SandboxConfig["services"][string];

/** Runtime values needed to materialize a tool's service commands. */
export interface ToolContext {
  workspaceDir: string;
  dashboardDomain: string;
  opencodePassword?: string;
  opencodeEnv?: Record<string, string>;
}

type IngressAnnotationSet = "vscode" | "opencode";

export interface ToolExposure {
  /** Subdomain prefix → `${subdomain}-${sandboxId}.${dashboardDomain}`. */
  subdomain: string;
  /** Key into `config.ports` for the service port the ingress targets. */
  portKey: "vscode" | "opencode" | "browser";
  /** Which configured ingress annotation set to apply. */
  annotations: IngressAnnotationSet;
}

export type ToolStart = "boot" | "lazy";

export interface ToolDefinition {
  slug: string;
  name: string;
  /** Core tools are always present and started, even without a workspace. */
  core?: boolean;
  /** `boot` = ingress + service started at spawn; `lazy` = on demand. */
  start: ToolStart;
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
      portKey: "vscode",
      annotations: "vscode",
    },
    autoStartServices: ["vscode"],
    buildServices: (ctx) => {
      const port = config.ports.vscode;
      return {
        vscode: {
          port,
          command: `/opt/shared/bin/code-server --bind-addr 0.0.0.0:${port} --auth none --disable-telemetry ${ctx.workspaceDir}`,
          user: "dev",
          autoStart: true,
        },
      };
    },
  },
  {
    slug: "opencode",
    name: "OpenCode",
    core: true,
    start: "boot",
    exposure: {
      subdomain: "opencode",
      portKey: "opencode",
      annotations: "opencode",
    },
    autoStartServices: ["opencode"],
    buildServices: (ctx) => {
      const port = config.ports.opencode;
      return {
        opencode: {
          port,
          command: `cd ${ctx.workspaceDir} && /opt/shared/bin/opencode serve --hostname 0.0.0.0 --port ${port} --cors https://${ctx.dashboardDomain}`,
          user: "dev",
          autoStart: true,
          env: {
            ...(ctx.opencodePassword && {
              OPENCODE_SERVER_PASSWORD: ctx.opencodePassword,
            }),
            // Forwarded from the local opencode-atelier plugin. Anything
            // missing here leaves the remote opencode in non-workspace mode.
            ...(ctx.opencodeEnv ?? {}),
          },
        },
      };
    },
  },
  {
    slug: "terminal",
    name: "Terminal",
    start: "boot",
    // Ensured by the agent itself (ensure_terminal_from_config), never started
    // by the manager — hence no autoStart services and no HTTP exposure here.
    autoStartServices: [],
    buildServices: () => ({
      terminal: {
        port: config.ports.terminal,
        enabled: true,
      },
    }),
  },
  {
    slug: "browser",
    name: "Browser",
    start: "lazy",
    startDelayMs: 500,
    exposure: {
      subdomain: "browser",
      portKey: "browser",
      // Browser reuses the vscode ingress annotations (matches prior behavior).
      annotations: "vscode",
    },
    autoStartServices: ["kasmvnc", "openbox", "chromium"],
    buildServices: () => {
      const port = config.ports.browser;
      return {
        kasmvnc: {
          port,
          command: `Xvnc :99 -geometry 1280x900 -depth 24 -websocketPort ${port} -SecurityTypes None -AlwaysShared -AcceptSetDesktopSize -DisableBasicAuth -UseIPv6 0 -interface 0.0.0.0 -httpd /usr/share/kasmvnc/www -FrameRate 60 -DynamicQualityMin 7 -DynamicQualityMax 9 -RectThreads 0 -CompareFB 2 -DetectScrolling -sslOnly 0`,
          user: "root",
          autoStart: false,
        },
        openbox: {
          command: "openbox",
          user: "dev",
          autoStart: false,
          env: { DISPLAY: ":99" },
        },
        chromium: {
          command:
            "chromium --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage --no-first-run --disable-session-crashed-bubble --disable-infobars --disable-translate --disable-features=TranslateUI --password-store=basic --disable-background-networking --disable-sync --disable-extensions --disable-default-apps --disable-breakpad --disable-component-extensions-with-background-pages --disable-background-timer-throttling --force-device-scale-factor=1 --disable-lcd-text --renderer-process-limit=2 --disk-cache-size=104857600 --user-data-dir=/tmp/chromium-profile about:blank",
          user: "dev",
          autoStart: false,
          env: { DISPLAY: ":99" },
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

function resolveAnnotations(set: IngressAnnotationSet): Record<string, string> {
  return set === "opencode"
    ? config.kubernetes.openCodeIngressAnnotations
    : config.kubernetes.vsCodeIngressAnnotations;
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
    port: config.ports[exposure.portKey],
    sandboxDomain: config.domain.dashboard,
    ingressClassName: config.kubernetes.ingressClassName || undefined,
    annotations: resolveAnnotations(exposure.annotations),
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
