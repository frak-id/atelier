import { t } from "elysia";

const SandboxStatus = t.Union([
  t.Literal("creating"),
  t.Literal("running"),
  t.Literal("stopped"),
  t.Literal("error"),
]);

const BaseImageEnum = t.Union([
  t.Literal("dev-base"),
  t.Literal("dev-node"),
  t.Literal("dev-rust"),
  t.Literal("dev-python"),
  t.Literal("dev-go"),
]);

export const SandboxModel = {
  create: t.Object({
    id: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
    projectId: t.Optional(t.String()),
    baseImage: t.Optional(BaseImageEnum),
    branch: t.Optional(t.String()),
    vcpus: t.Optional(t.Number({ minimum: 1, maximum: 8 })),
    memoryMb: t.Optional(t.Number({ minimum: 512, maximum: 8192 })),
  }),

  createQueued: t.Object({
    id: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
    projectId: t.Optional(t.String()),
    baseImage: t.Optional(BaseImageEnum),
    branch: t.Optional(t.String()),
    vcpus: t.Optional(t.Number({ minimum: 1, maximum: 8 })),
    memoryMb: t.Optional(t.Number({ minimum: 512, maximum: 8192 })),
    async: t.Optional(t.Boolean()),
  }),

  response: t.Object({
    id: t.String(),
    status: SandboxStatus,
    projectId: t.Optional(t.String()),
    branch: t.Optional(t.String()),
    ipAddress: t.String(),
    macAddress: t.String(),
    urls: t.Object({
      vscode: t.String(),
      opencode: t.String(),
      terminal: t.String(),
      ssh: t.String(),
    }),
    resources: t.Object({
      vcpus: t.Number(),
      memoryMb: t.Number(),
    }),
    pid: t.Optional(t.Number()),
    createdAt: t.String(),
    updatedAt: t.String(),
    error: t.Optional(t.String()),
  }),

  jobResponse: t.Object({
    id: t.String(),
    status: t.Union([
      t.Literal("queued"),
      t.Literal("running"),
      t.Literal("completed"),
      t.Literal("failed"),
    ]),
    queuedAt: t.String(),
    startedAt: t.Optional(t.String()),
    completedAt: t.Optional(t.String()),
    error: t.Optional(t.String()),
  }),

  listQuery: t.Object({
    status: t.Optional(SandboxStatus),
    projectId: t.Optional(t.String()),
  }),

  idParam: t.Object({
    id: t.String(),
  }),
};
