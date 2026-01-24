import type { Static } from "elysia";
import { t } from "elysia";

export const TaskTemplateModelSchema = t.Object({
  providerID: t.String(),
  modelID: t.String(),
});
export type TaskTemplateModel = Static<typeof TaskTemplateModelSchema>;

export const TaskTemplateVariantSchema = t.Object({
  name: t.String({ minLength: 1 }),
  model: TaskTemplateModelSchema,
  variant: t.Optional(t.String()),
  agent: t.Optional(t.String()),
});
export type TaskTemplateVariant = Static<typeof TaskTemplateVariantSchema>;

export const TaskTemplateSchema = t.Object({
  id: t.String({ minLength: 1 }),
  name: t.String({ minLength: 1 }),
  description: t.Optional(t.String()),
  promptTemplate: t.Optional(t.String()),
  variants: t.Array(TaskTemplateVariantSchema, { minItems: 1 }),
  defaultVariantIndex: t.Optional(t.Number({ minimum: 0, default: 0 })),
});
export type TaskTemplate = Static<typeof TaskTemplateSchema>;

export const TaskTemplatesSchema = t.Array(TaskTemplateSchema);
export type TaskTemplates = Static<typeof TaskTemplatesSchema>;

export const UpdateTaskTemplatesBodySchema = t.Object({
  templates: TaskTemplatesSchema,
});
export type UpdateTaskTemplatesBody = Static<
  typeof UpdateTaskTemplatesBodySchema
>;

export const MergedTaskTemplatesResponseSchema = t.Object({
  templates: TaskTemplatesSchema,
  source: t.Union([
    t.Literal("default"),
    t.Literal("global"),
    t.Literal("workspace"),
    t.Literal("merged"),
  ]),
});
export type MergedTaskTemplatesResponse = Static<
  typeof MergedTaskTemplatesResponseSchema
>;

export const OpenCodeModelInfoSchema = t.Object({
  id: t.String(),
  name: t.String(),
  variants: t.Optional(t.Record(t.String(), t.Unknown())),
});
export type OpenCodeModelInfo = Static<typeof OpenCodeModelInfoSchema>;

export const OpenCodeProviderInfoSchema = t.Object({
  id: t.String(),
  name: t.String(),
  models: t.Record(t.String(), OpenCodeModelInfoSchema),
});
export type OpenCodeProviderInfo = Static<typeof OpenCodeProviderInfoSchema>;

export const OpenCodeAgentInfoSchema = t.Object({
  name: t.String(),
  description: t.Optional(t.String()),
  mode: t.String(),
});
export type OpenCodeAgentInfo = Static<typeof OpenCodeAgentInfoSchema>;

export const OpenCodeConfigResponseSchema = t.Object({
  available: t.Boolean(),
  sandboxId: t.Optional(t.String()),
  providers: t.Optional(t.Array(OpenCodeProviderInfoSchema)),
  agents: t.Optional(t.Array(OpenCodeAgentInfoSchema)),
});
export type OpenCodeConfigResponse = Static<
  typeof OpenCodeConfigResponseSchema
>;

export interface TaskTemplateVariables {
  task: {
    title: string;
    description: string;
    context?: string;
    branch?: string;
  };
  workspace: {
    name: string;
    reposName: string[];
  };
  sandbox: {
    id: string;
    ip: string;
    url: string;
  };
}
