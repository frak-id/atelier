import { t } from "elysia";

const BaseImageEnum = t.Union([
  t.Literal("dev-base"),
  t.Literal("dev-node"),
  t.Literal("dev-rust"),
  t.Literal("dev-python"),
  t.Literal("dev-go"),
]);

const PrebuildStatusEnum = t.Union([
  t.Literal("none"),
  t.Literal("building"),
  t.Literal("ready"),
  t.Literal("failed"),
]);

export const ProjectModel = {
  create: t.Object({
    name: t.String({ minLength: 1, maxLength: 100 }),
    gitUrl: t.String({ minLength: 1 }),
    defaultBranch: t.Optional(t.String()),
    baseImage: t.Optional(BaseImageEnum),
    vcpus: t.Optional(t.Number({ minimum: 1, maximum: 8 })),
    memoryMb: t.Optional(t.Number({ minimum: 512, maximum: 16384 })),
    initCommands: t.Optional(t.Array(t.String())),
    startCommands: t.Optional(t.Array(t.String())),
    secrets: t.Optional(t.Record(t.String(), t.String())),
    exposedPorts: t.Optional(t.Array(t.Number({ minimum: 1, maximum: 65535 }))),
  }),

  update: t.Object({
    name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
    gitUrl: t.Optional(t.String({ minLength: 1 })),
    defaultBranch: t.Optional(t.String()),
    baseImage: t.Optional(BaseImageEnum),
    vcpus: t.Optional(t.Number({ minimum: 1, maximum: 8 })),
    memoryMb: t.Optional(t.Number({ minimum: 512, maximum: 16384 })),
    initCommands: t.Optional(t.Array(t.String())),
    startCommands: t.Optional(t.Array(t.String())),
    secrets: t.Optional(t.Record(t.String(), t.String())),
    exposedPorts: t.Optional(t.Array(t.Number({ minimum: 1, maximum: 65535 }))),
  }),

  response: t.Object({
    id: t.String(),
    name: t.String(),
    gitUrl: t.String(),
    defaultBranch: t.String(),
    baseImage: BaseImageEnum,
    vcpus: t.Number(),
    memoryMb: t.Number(),
    initCommands: t.Array(t.String()),
    startCommands: t.Array(t.String()),
    secrets: t.Record(t.String(), t.String()),
    exposedPorts: t.Array(t.Number()),
    latestPrebuildId: t.Optional(t.String()),
    prebuildStatus: PrebuildStatusEnum,
    createdAt: t.String(),
    updatedAt: t.String(),
  }),

  listQuery: t.Object({
    prebuildStatus: t.Optional(PrebuildStatusEnum),
  }),

  idParam: t.Object({
    id: t.String(),
  }),
};
