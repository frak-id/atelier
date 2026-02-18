import type {
  AppAgentsResponse,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2";
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

export type OpenCodeConfigResponse = {
  available: boolean;
  sandboxId?: string;
  providers?: ProviderListResponse["all"];
  agents?: AppAgentsResponse;
};

export interface SessionTemplateVariables {
  task: {
    description: string;
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
