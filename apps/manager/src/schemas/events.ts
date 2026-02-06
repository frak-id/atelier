import type { Static } from "elysia";
import { t } from "elysia";

/* -------------------------------------------------------------------------- */
/*                              Sandbox Events                                */
/* -------------------------------------------------------------------------- */

const SandboxCreatedSchema = t.Object({
  type: t.Literal("sandbox.created"),
  properties: t.Object({
    id: t.String(),
    workspaceId: t.Optional(t.String()),
  }),
});

const SandboxUpdatedSchema = t.Object({
  type: t.Literal("sandbox.updated"),
  properties: t.Object({
    id: t.String(),
    status: t.String(),
  }),
});

const SandboxDeletedSchema = t.Object({
  type: t.Literal("sandbox.deleted"),
  properties: t.Object({
    id: t.String(),
    workspaceId: t.Optional(t.String()),
  }),
});

const SandboxServicesChangedSchema = t.Object({
  type: t.Literal("sandbox.services.changed"),
  properties: t.Object({ id: t.String() }),
});

const SandboxGitChangedSchema = t.Object({
  type: t.Literal("sandbox.git.changed"),
  properties: t.Object({ id: t.String() }),
});

/* -------------------------------------------------------------------------- */
/*                             Prebuild Events                                */
/* -------------------------------------------------------------------------- */

const PrebuildUpdatedSchema = t.Object({
  type: t.Literal("prebuild.updated"),
  properties: t.Object({
    workspaceId: t.String(),
    status: t.String(),
  }),
});

export const PrebuildEventSchema = PrebuildUpdatedSchema;
export type PrebuildEvent = Static<typeof PrebuildEventSchema>;

export const SandboxEventSchema = t.Union([
  SandboxCreatedSchema,
  SandboxUpdatedSchema,
  SandboxDeletedSchema,
  SandboxServicesChangedSchema,
  SandboxGitChangedSchema,
]);
export type SandboxEvent = Static<typeof SandboxEventSchema>;

/* -------------------------------------------------------------------------- */
/*                                Task Events                                 */
/* -------------------------------------------------------------------------- */

const TaskCreatedSchema = t.Object({
  type: t.Literal("task.created"),
  properties: t.Object({
    id: t.String(),
    workspaceId: t.String(),
  }),
});

const TaskUpdatedSchema = t.Object({
  type: t.Literal("task.updated"),
  properties: t.Object({
    id: t.String(),
    workspaceId: t.String(),
  }),
});

const TaskDeletedSchema = t.Object({
  type: t.Literal("task.deleted"),
  properties: t.Object({
    id: t.String(),
    workspaceId: t.String(),
  }),
});

export const TaskEventSchema = t.Union([
  TaskCreatedSchema,
  TaskUpdatedSchema,
  TaskDeletedSchema,
]);
export type TaskEvent = Static<typeof TaskEventSchema>;

/* -------------------------------------------------------------------------- */
/*                             Workspace Events                               */
/* -------------------------------------------------------------------------- */

const WorkspaceCreatedSchema = t.Object({
  type: t.Literal("workspace.created"),
  properties: t.Object({ id: t.String() }),
});

const WorkspaceUpdatedSchema = t.Object({
  type: t.Literal("workspace.updated"),
  properties: t.Object({ id: t.String() }),
});

const WorkspaceDeletedSchema = t.Object({
  type: t.Literal("workspace.deleted"),
  properties: t.Object({ id: t.String() }),
});

export const WorkspaceEventSchema = t.Union([
  WorkspaceCreatedSchema,
  WorkspaceUpdatedSchema,
  WorkspaceDeletedSchema,
]);
export type WorkspaceEvent = Static<typeof WorkspaceEventSchema>;

/* -------------------------------------------------------------------------- */
/*                              Config Events                                 */
/* -------------------------------------------------------------------------- */

const ConfigCreatedSchema = t.Object({
  type: t.Literal("config.created"),
  properties: t.Object({
    id: t.String(),
    scope: t.String(),
    workspaceId: t.Optional(t.String()),
  }),
});

const ConfigUpdatedSchema = t.Object({
  type: t.Literal("config.updated"),
  properties: t.Object({
    id: t.String(),
    scope: t.String(),
    workspaceId: t.Optional(t.String()),
  }),
});

const ConfigDeletedSchema = t.Object({
  type: t.Literal("config.deleted"),
  properties: t.Object({
    id: t.String(),
    scope: t.String(),
    workspaceId: t.Optional(t.String()),
  }),
});

export const ConfigEventSchema = t.Union([
  ConfigCreatedSchema,
  ConfigUpdatedSchema,
  ConfigDeletedSchema,
]);
export type ConfigEvent = Static<typeof ConfigEventSchema>;

/* -------------------------------------------------------------------------- */
/*                             Manager Event                                  */
/* -------------------------------------------------------------------------- */

export const ManagerEventSchema = t.Union([
  ...SandboxEventSchema.anyOf,
  ...TaskEventSchema.anyOf,
  ...WorkspaceEventSchema.anyOf,
  ...ConfigEventSchema.anyOf,
  PrebuildEventSchema,
]);
export type ManagerEvent = Static<typeof ManagerEventSchema>;
