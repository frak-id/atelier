/**
 * The integration contract. An integration pushes an event to an external
 * agent UI (Steery today), which may answer it: today an agent's permission
 * prompt in an Atelier-driven session (console chat, MCP tasks, Launchpad),
 * routed to the sandbox OWNER's connections. The first answer wins, from the
 * console or any UI.
 *
 * Integrations are compiled in (`catalog.ts`), switched on by the operator
 * through the server's environment (never over the API), and connected by
 * each person (an optional write-only credential).
 *
 * Boundary (check:boundary): `integrations/` never imports control/,
 * sessions/ or runtime/ — everything an integration may touch arrives
 * through these arguments, wired in `api/container.ts`. A vendor directory
 * `integrations/<id>/` imports only `../integration.ts`, `shared/` and the
 * workspace packages, and only `catalog.ts` imports a vendor directory.
 *
 * A hook is added here only together with its first caller and a test.
 */
import type { PermissionRisk } from "@frak/atelier-shared";
import type { createChildLogger } from "../shared/lib/logger.ts";

export interface Integration {
  manifest: IntegrationManifest;
  /**
   * Outbound: a permission prompt in a sandbox whose owner connected this
   * integration, and whose risk passed that connection's filter. Resolve
   * when done (answered, withdrawn, or gave up); a throw is logged and the
   * prompt stays pending for the console. Must stop, and withdraw whatever
   * it raised, once `ctx.signal` aborts.
   */
  onPermission?(
    request: PermissionRequest,
    ctx: PermissionContext,
  ): Promise<void>;
}

export interface IntegrationManifest {
  /** Stable id, `/^[a-z][a-z0-9-]{1,30}$/`. */
  id: string;
  /** Display name, e.g. "Steery". */
  label: string;
  /** One sentence for Settings → Integrations. */
  description: string;
  docsUrl?: string;
  /**
   * Operator settings, read from the server's environment ONLY (an API-
   * editable value could repoint where people's credentials are sent):
   * `ATELIER_INTEGRATION_<ID>_<NAME>` — the id upper-cased with `-` → `_`,
   * the camelCase name to UPPER_SNAKE (`url` → `…_URL`). The integration
   * itself is on when `ATELIER_INTEGRATION_<ID>` is `true`/`1`.
   */
  serverSettings?: readonly ServerSettingDef[];
  /** A write-only credential a person gives when connecting (their key at
   * the UI's service). Stored encrypted, never returned, never a secret
   * (a secret can be resolved into a sandbox, where the agent could read
   * it). */
  credential?: { label: string; required: boolean; help?: string };
}

export interface ServerSettingDef {
  /** camelCase, `/^[a-z][a-zA-Z0-9]{0,30}$/`. */
  name: string;
  /** `url`: an absolute URL, https in production. */
  type: "string" | "url";
  default: string;
}

/** One agent permission prompt, as an integration sees it. */
export interface PermissionRequest {
  /** The pending permission id (the public reply route takes it). */
  requestId: string;
  sandboxId: string;
  /** The sandbox's display name, else its id. */
  sandboxName: string;
  /** The tool call's title, else its kind, else "permission". */
  title: string;
  /** The ACP tool kind (`edit`, `execute`, `fetch`, …), when given. */
  kind?: string;
  /** Computed by the hub from the kind (title as fallback). */
  risk: PermissionRisk;
  /** The answers the agent offers, in its order. */
  options: { optionId: string; name: string; kind: string }[];
}

export interface PermissionContext {
  /** Answer with one of the request's `optionId`s. The first answer wins; a
   * no-op once settled; an id that was not offered is ignored. */
  answer(optionId: string): void;
  /** Aborts once the prompt is settled without this integration (console,
   * another integration, the agent connection closed). */
  signal: AbortSignal;
  /** The operator's `serverSettings` values (defaults filled in). */
  serverSettings: Readonly<Record<string, string>>;
  /** The connection of the sandbox's owner. */
  connection: { credential?: string };
  log: ReturnType<typeof createChildLogger>;
}
