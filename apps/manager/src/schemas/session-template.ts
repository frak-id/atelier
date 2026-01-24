import type { Static } from "elysia";
import { t } from "elysia";

export const SessionTemplateModelSchema = t.Object({
  providerID: t.String(),
  modelID: t.String(),
});
export type SessionTemplateModel = Static<typeof SessionTemplateModelSchema>;

export const SessionTemplateVariantSchema = t.Object({
  name: t.String({ minLength: 1 }),
  model: SessionTemplateModelSchema,
  variant: t.Optional(t.String()),
  agent: t.Optional(t.String()),
});
export type SessionTemplateVariant = Static<
  typeof SessionTemplateVariantSchema
>;

export const SessionTemplateCategoryValues = ["primary", "secondary"] as const;
export type SessionTemplateCategory =
  (typeof SessionTemplateCategoryValues)[number];

export const SessionTemplateSchema = t.Object({
  id: t.String({ minLength: 1 }),
  name: t.String({ minLength: 1 }),
  category: t.Union([t.Literal("primary"), t.Literal("secondary")]),
  description: t.Optional(t.String()),
  promptTemplate: t.Optional(t.String()),
  variants: t.Array(SessionTemplateVariantSchema, { minItems: 1 }),
  defaultVariantIndex: t.Optional(t.Number({ minimum: 0, default: 0 })),
});
export type SessionTemplate = Static<typeof SessionTemplateSchema>;

export const SessionTemplatesSchema = t.Array(SessionTemplateSchema);
export type SessionTemplates = Static<typeof SessionTemplatesSchema>;

export const UpdateSessionTemplatesBodySchema = t.Object({
  templates: SessionTemplatesSchema,
});
export type UpdateSessionTemplatesBody = Static<
  typeof UpdateSessionTemplatesBodySchema
>;

export const MergedSessionTemplatesResponseSchema = t.Object({
  templates: SessionTemplatesSchema,
  source: t.Union([
    t.Literal("default"),
    t.Literal("global"),
    t.Literal("workspace"),
    t.Literal("merged"),
  ]),
});
export type MergedSessionTemplatesResponse = Static<
  typeof MergedSessionTemplatesResponseSchema
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

export interface SessionTemplateVariables {
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
