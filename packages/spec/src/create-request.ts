/**
 * The `POST /v1/sandboxes` seam input and the template "composition" it comes
 * from. Kept out of `sandbox-spec.ts` because it references `PrebuildSpec`
 * (whose module imports `sandbox-spec.ts`) — defining it here keeps the schema
 * module graph acyclic.
 *
 * The seam resolves the high-level references before the runtime sees a spec:
 * `toolboxes` selectors → materialized toolset refs (latest build), and a
 * `prebuild` recipe → the current snapshot ref (`source.snapshot`). Storing
 * those references — instead of a pinned `source.snapshot`/`toolsets` — is what
 * lets a template follow an updated prebuild or toolbox.
 */
import { type Static, Type } from "@sinclair/typebox";
import { PrebuildSpecSchema } from "./prebuild-spec.ts";
import { SandboxSpecSchema, ToolboxSelectorSchema } from "./sandbox-spec.ts";

/**
 * The `POST /v1/sandboxes` body: a `SandboxSpec` plus optional high-level
 * references the seam resolves. `toolboxes` are selectors resolved to the
 * latest toolset build; `prebuild` is a recipe resolved (idempotently, a cache
 * hit when unchanged) to the current snapshot, overriding `source`. A plain
 * `SandboxSpec` (neither field) is still a valid body, so the
 * CLI/editor paths are unchanged.
 *
 * `personalize: false` is for an external control plane that owns the
 * sandbox's content and identity (e.g. Open-Inspect): the seam then skips the
 * caller's personal environment — auto-injected org/user toolboxes, the org's
 * default harness, and the caller's git identity + credentials. Org policy
 * fragments and secret resolution always apply.
 */
export const CreateSandboxRequestSchema = Type.Composite(
  [
    SandboxSpecSchema,
    Type.Object({
      toolboxes: Type.Optional(Type.Array(ToolboxSelectorSchema)),
      prebuild: Type.Optional(PrebuildSpecSchema),
      personalize: Type.Optional(
        Type.Boolean({
          description:
            "Apply the caller's auto-injected toolboxes, default harness and " +
            "git identity/credentials (default true). Set false when an " +
            "external control plane owns the sandbox.",
        }),
      ),
    }),
  ],
  { additionalProperties: false, $id: "CreateSandboxRequest" },
);
export type CreateSandboxRequest = Static<typeof CreateSandboxRequestSchema>;
