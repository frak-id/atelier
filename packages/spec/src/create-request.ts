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
import {
  ResourcesSchema,
  SandboxSpecSchema,
  ToolboxSelectorSchema,
} from "./sandbox-spec.ts";

/**
 * The `POST /v1/sandboxes` body: a `SandboxSpec` plus optional high-level
 * references the seam resolves. `toolboxes` are selectors resolved to the
 * latest toolset build; `prebuild` is a recipe resolved (idempotently, a cache
 * hit when unchanged) to the current snapshot, overriding `source`. A plain
 * `SandboxSpec` (neither field) is still a valid body, so the
 * CLI/editor paths are unchanged.
 *
 * `orgId` picks the organization the sandbox runs in: its secrets, policy
 * and auto-injected toolboxes. The caller must be a member; absent, it's
 * the caller's personal org.
 *
 * `repo` is sugar over `prebuild`: boot from a git repo (an existing bake of
 * it, else a quick one-repo prebuild on the `source.image` base). It is
 * refused together with `prebuild` or a `source.snapshot`.
 *
 * `resources` is optional here (and each field inside it): the seam fills
 * whatever is missing from the server's `sandbox.defaultVcpus` /
 * `sandbox.defaultMemoryMb` config, so the runtime's `SandboxSpec` still sees
 * a complete `resources`.
 */
const CreateSandboxRepoSchema = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
    branch: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export const CreateSandboxRequestSchema = Type.Composite(
  [
    Type.Omit(SandboxSpecSchema, ["resources"]),
    Type.Object({
      resources: Type.Optional(Type.Partial(ResourcesSchema)),
      toolboxes: Type.Optional(Type.Array(ToolboxSelectorSchema)),
      prebuild: Type.Optional(PrebuildSpecSchema),
      repo: Type.Optional(CreateSandboxRepoSchema),
      orgId: Type.Optional(Type.String({ minLength: 1 })),
    }),
  ],
  { additionalProperties: false, $id: "CreateSandboxRequest" },
);
export type CreateSandboxRequest = Static<typeof CreateSandboxRequestSchema>;
