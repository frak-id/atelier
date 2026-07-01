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

/**
 * Harness-neutral shape of the model/agent config a running sandbox advertises,
 * consumed by the session-template editor. This is the structural subset the
 * dashboard reads; the opencode-specific service maps its SDK response onto it,
 * so no harness SDK type leaks into the wire contract.
 */
export interface AgentProviderModel {
  id: string;
  name: string;
  /** Variant name -> variant config; keys are the selectable variant names. */
  variants?: Record<string, unknown>;
}
export interface AgentProvider {
  id: string;
  name: string;
  models: Record<string, AgentProviderModel>;
}
export interface AgentDefinition {
  name: string;
  mode?: string;
  hidden?: boolean;
}
export type AgentConfigResponse = {
  available: boolean;
  sandboxId?: string;
  providers?: AgentProvider[];
  agents?: AgentDefinition[];
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
