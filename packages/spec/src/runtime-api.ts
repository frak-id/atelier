/**
 * Request/response shapes for the runtime API (atelier-v2 §2 "Runtime API").
 * These are the wire contract at the seam — the whole thing.
 */
import { type Static, Type } from "@sinclair/typebox";
import { ProcessSchema, SandboxSpecSchema } from "./sandbox-spec.ts";

// ── generated values ─────────────────────────────────────────────────────────

/**
 * Runtime-generated values returned in the create response. The spec stays a
 * pure input; mid-boot values (agent password, pod IP, per-sandbox tokens)
 * come back here (atelier-v2 §6 phase 1 "mid-boot values").
 */
export const GeneratedSchema = Type.Object(
  {
    agentPassword: Type.Optional(Type.String()),
    podIp: Type.Optional(Type.String()),
    tokens: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: true, $id: "Generated" },
);
export type Generated = Static<typeof GeneratedSchema>;

// ── urls ─────────────────────────────────────────────────────────────────────

export const SandboxUrlSchema = Type.Object(
  {
    name: Type.String(),
    url: Type.String(),
    /** All processes that gate this URL (design ui-evolution.md §4.1). Undefined
     * when the port has no declared gating process (e.g. `ssh`). */
    processes: Type.Optional(Type.Array(Type.String())),
    /** True iff every process in `processes` is live-ready. Undefined when
     * `processes` is undefined, or when live status wasn't computed (create). */
    ready: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type SandboxUrl = Static<typeof SandboxUrlSchema>;

// ── status ─────────────────────────────────────────────────────────────────

export const SandboxStatusSchema = Type.Union([
  Type.Literal("creating"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("stopped"),
  Type.Literal("error"),
]);
export type SandboxStatus = Static<typeof SandboxStatusSchema>;

export const ProcessStatusSchema = Type.Object(
  {
    name: Type.String(),
    running: Type.Boolean(),
    ready: Type.Optional(Type.Boolean()),
    primary: Type.Optional(Type.Boolean()),
    exitCode: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);
export type ProcessStatus = Static<typeof ProcessStatusSchema>;

// ── create ───────────────────────────────────────────────────────────────────

export const CreateSandboxResponseSchema = Type.Object(
  {
    id: Type.String(),
    urls: Type.Array(SandboxUrlSchema),
    generated: Type.Optional(GeneratedSchema),
  },
  { additionalProperties: false, $id: "CreateSandboxResponse" },
);
export type CreateSandboxResponse = Static<typeof CreateSandboxResponseSchema>;

// ── get ──────────────────────────────────────────────────────────────────────

export const SandboxStateSchema = Type.Object(
  {
    id: Type.String(),
    status: SandboxStatusSchema,
    urls: Type.Array(SandboxUrlSchema),
    processes: Type.Array(ProcessStatusSchema),
    generated: Type.Optional(GeneratedSchema),
    metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
    annotations: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false, $id: "SandboxState" },
);
export type SandboxState = Static<typeof SandboxStateSchema>;

// ── list ─────────────────────────────────────────────────────────────────────

/** Lightweight sandbox row for `GET /v1/sandboxes` (`atelier ps`): from the
 * persisted record only — no per-sandbox agent round-trips. Live process
 * health is on `GET /v1/sandboxes/:id`. */
export const SandboxSummarySchema = Type.Object(
  {
    id: Type.String(),
    status: SandboxStatusSchema,
    createdAt: Type.String(),
    annotations: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false, $id: "SandboxSummary" },
);
export type SandboxSummary = Static<typeof SandboxSummarySchema>;

// ── resume ───────────────────────────────────────────────────────────────────

export const ResumeRequestSchema = Type.Object(
  {
    files: Type.Optional(SandboxSpecSchema.properties.files),
    env: Type.Optional(SandboxSpecSchema.properties.env),
  },
  { additionalProperties: false, $id: "ResumeRequest" },
);
export type ResumeRequest = Static<typeof ResumeRequestSchema>;

// ── live mutations ─────────────────────────────────────────────────────────

export const PatchFilesRequestSchema = Type.Array(
  Type.Object(
    {
      path: Type.String(),
      content: Type.String(),
      mode: Type.Optional(Type.String()),
      owner: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  { $id: "PatchFilesRequest" },
);
export type PatchFilesRequest = Static<typeof PatchFilesRequestSchema>;

export const PatchEnvRequestSchema = Type.Record(Type.String(), Type.String(), {
  $id: "PatchEnvRequest",
});
export type PatchEnvRequest = Static<typeof PatchEnvRequestSchema>;

/** Ad-hoc supervised process registered after boot. */
export const AddProcessRequestSchema = ProcessSchema;
export type AddProcessRequest = Static<typeof AddProcessRequestSchema>;

export const AddPortRequestSchema = Type.Object(
  {
    name: Type.String(),
    port: Type.Number(),
    public: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, $id: "AddPortRequest" },
);
export type AddPortRequest = Static<typeof AddPortRequestSchema>;

export const ExecRequestSchema = Type.Object(
  {
    command: Type.String(),
    cwd: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  },
  { additionalProperties: false, $id: "ExecRequest" },
);
export type ExecRequest = Static<typeof ExecRequestSchema>;
