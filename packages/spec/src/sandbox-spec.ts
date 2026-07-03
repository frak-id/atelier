/**
 * The `SandboxSpec` — one document, fully resolved. This is what the Atelier
 * v2 runtime accepts and the only thing it understands (atelier-v2 §2).
 *
 * The runtime knows only mechanism, never content: no `harness`, no `mcp`, no
 * `skills`, no `tools`, no `dev`. A harness is the `acp` process + its config
 * files. An MCP server is a file (or a stdio process). vscode is a lazy
 * process + a port. The runtime cannot bloat because it has no opinion.
 */
import { type Static, Type } from "@sinclair/typebox";
import { MaybeSecretStringSchema } from "./secret-ref.ts";

// ── boot source ─────────────────────────────────────────────────────────────

/** Boot source — exactly one of image OR snapshot. */
export const SourceSchema = Type.Union(
  [
    Type.Object(
      {
        image: Type.String({ description: "OCI image ref, e.g. dev-base:1.4" }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        snapshot: Type.String({
          description: "A prebuild/pause snapshot ref, e.g. snap_ws-frak-7f3a",
        }),
      },
      { additionalProperties: false },
    ),
  ],
  { description: "Boot source — exactly one of `image` or `snapshot`." },
);
export type Source = Static<typeof SourceSchema>;

// ── resources ───────────────────────────────────────────────────────────────

export const ResourcesSchema = Type.Object(
  {
    vcpus: Type.Number({ minimum: 1 }),
    memoryMb: Type.Number({ minimum: 256 }),
    diskGb: Type.Optional(Type.Number({ minimum: 1 })),
  },
  { additionalProperties: false },
);
export type Resources = Static<typeof ResourcesSchema>;

// ── files ───────────────────────────────────────────────────────────────────

/** A file written before processes start. */
export const FileSchema = Type.Object(
  {
    path: Type.String(),
    content: MaybeSecretStringSchema,
    mode: Type.Optional(Type.String({ description: 'Octal, e.g. "600".' })),
    owner: Type.Optional(Type.String({ description: 'e.g. "dev" or "root".' })),
  },
  { additionalProperties: false },
);
export type FileEntry = Static<typeof FileSchema>;

// ── processes ───────────────────────────────────────────────────────────────

/**
 * Per-process readiness probe. The one mechanism concession — typed on purpose
 * (atelier-v2 §2). Exactly one of `port` | `http` | `cmd`.
 */
export const ReadinessSchema = Type.Union([
  Type.Object({ port: Type.Number() }, { additionalProperties: false }),
  Type.Object({ http: Type.String() }, { additionalProperties: false }),
  Type.Object({ cmd: Type.String() }, { additionalProperties: false }),
]);
export type Readiness = Static<typeof ReadinessSchema>;

/** How the supervisor attaches to a process's stdio. */
export const StdioModeSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("bridge"),
]);
export type StdioMode = Static<typeof StdioModeSchema>;

export const RestartPolicySchema = Type.Union([
  Type.Literal("never"),
  Type.Literal("on-failure"),
  Type.Literal("always"),
]);
export type RestartPolicy = Static<typeof RestartPolicySchema>;

/**
 * A supervised process. `name` is the only identity. The process model is
 * `readiness` + `primary` + `after` + `restart` + `lazy` — each maps 1:1 to an
 * accepted industry primitive (atelier-v2 §2 "standing guard").
 */
export const ProcessSchema = Type.Object(
  {
    name: Type.String({ description: "Unique identity of the process." }),
    command: Type.String(),
    cwd: Type.Optional(Type.String()),
    /**
     * uid to spawn under (maps 1:1 to systemd `User=`). Defaults are the
     * runtime's concern; the guest agent honours it at spawn.
     */
    user: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(Type.String(), MaybeSecretStringSchema)),
    /**
     * Sandbox "ready"/"healthy" == this process. Generic replacement for v1's
     * hardcoded opencode gate in boot-waiter.ts.
     */
    primary: Type.Optional(Type.Boolean()),
    /** stdio attachment mode. `bridge` relays stdin/stdout over a WS endpoint. */
    stdio: Type.Optional(StdioModeSchema),
    /** Allocate a PTY for this process (today's terminal). */
    pty: Type.Optional(Type.Boolean()),
    readiness: Type.Optional(ReadinessSchema),
    /** Wait for these processes' readiness before spawning. */
    after: Type.Optional(Type.Array(Type.String())),
    restart: Type.Optional(RestartPolicySchema),
    /** Socket-activation style: spawn on first access rather than at boot. */
    lazy: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ProcessEntry = Static<typeof ProcessSchema>;

// ── ports ───────────────────────────────────────────────────────────────────

export const PortAuthSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("forward"),
]);

/** Thin annotation, nothing more. Hostname pattern `{name}-{sandboxId}.{domain}`. */
export const PortSchema = Type.Object(
  {
    name: Type.String(),
    port: Type.Number(),
    public: Type.Optional(Type.Boolean()),
    auth: Type.Optional(PortAuthSchema),
  },
  { additionalProperties: false },
);
export type PortEntry = Static<typeof PortSchema>;

// ── hooks ───────────────────────────────────────────────────────────────────

/** Arbitrary shell, phase-scheduled, ordered. */
export const HooksSchema = Type.Object(
  {
    postCreate: Type.Optional(Type.Array(Type.String())),
    postStart: Type.Optional(Type.Array(Type.String())),
    /** Fires on every resume — the credential-rotation primitive (atelier-v2 §2). */
    onResume: Type.Optional(Type.Array(Type.String())),
    /** Fired by `PATCH /env`; user wires it to reload/SIGHUP their processes. */
    envChanged: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
export type Hooks = Static<typeof HooksSchema>;

// ── caches ──────────────────────────────────────────────────────────────────

/** Optional warm-cache volume — a small per-key PVC persisted across a key's sandboxes. */
export const CacheSchema = Type.Object(
  { name: Type.String(), path: Type.String() },
  { additionalProperties: false },
);
export type CacheEntry = Static<typeof CacheSchema>;

// ── toolsets ────────────────────────────────────────────────────────────────

/**
 * A resolved toolset reference — the ONLY toolset shape a `SandboxSpec`
 * carries. `ref` is a host-relative OCI locator (`toolsets/<name>@sha256:…`);
 * the runtime prepends the configured registry host to pull it. Names,
 * harnesses, and profiles are resolved to this by control/compose before the
 * spec crosses the seam. Defined here (not `toolset-spec.ts`) to keep the
 * schema module graph acyclic — the build/capture/entry shapes import it back.
 */
export const ToolsetRefSchema = Type.Object(
  {
    ref: Type.String({
      description:
        "Host-relative OCI locator, e.g. toolsets/alice-pi-stack@sha256:3a9f…",
    }),
  },
  { additionalProperties: false, $id: "ToolsetRef" },
);
export type ToolsetRef = Static<typeof ToolsetRefSchema>;

// ── the spec ────────────────────────────────────────────────────────────────

export const SandboxSpecSchema = Type.Object(
  {
    source: SourceSchema,
    resources: ResourcesSchema,
    files: Type.Optional(Type.Array(FileSchema)),
    env: Type.Optional(Type.Record(Type.String(), MaybeSecretStringSchema)),
    processes: Type.Optional(Type.Array(ProcessSchema)),
    ports: Type.Optional(Type.Array(PortSchema)),
    hooks: Type.Optional(HooksSchema),
    caches: Type.Optional(Type.Array(CacheSchema)),
    /**
     * Toolset artifacts materialized into the home before the files/env phase
     * (composed-prebuild-volumes.md §3). Resolved digest locators only — the
     * runtime never sees a name/harness/profile. Materialized in list order
     * (later wins on path conflicts, same rule as `files[]`).
     */
    toolsets: Type.Optional(Type.Array(ToolsetRefSchema)),
    timeoutSeconds: Type.Optional(Type.Number()),
    /** Opaque pass-through — the runtime threads it and never reads it. */
    metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
    /** Display hints, never behaviour. The runtime never reads them. */
    annotations: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  {
    additionalProperties: false,
    $id: "SandboxSpec",
    description:
      "One fully-resolved document. The only thing the v2 runtime understands.",
  },
);
export type SandboxSpec = Static<typeof SandboxSpecSchema>;
