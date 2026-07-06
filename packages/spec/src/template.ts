/**
 * Sandbox-template presentation metadata (design ui-evolution.md §2.1). A
 * "template" is a saved spec published to the spawn gallery; this metadata is
 * presentation-only and never affects the stored spec's runtime contract.
 *
 * Defined once here (the package both server and console already depend on)
 * so the DB `$type`, the request-body validation, and the console types all
 * derive from a single source and can't drift.
 */
import { type Static, Type } from "@sinclair/typebox";

/** One fill-in-the-blank input a template's spawn card renders (design
 * ui-evolution.md §2.2). Param kinds are code, values are data — no
 * `{{var}}` string interpolation into the stored spec. */
export const TemplateParamSchema = Type.Object({
  key: Type.String(),
  label: Type.String(),
  kind: Type.Union([Type.Literal("repo-url"), Type.Literal("string")]),
  required: Type.Optional(Type.Boolean()),
  hint: Type.Optional(Type.String()),
});
export type TemplateParam = Static<typeof TemplateParamSchema>;

export const TemplateMetaSchema = Type.Object({
  description: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String()),
  params: Type.Optional(Type.Array(TemplateParamSchema)),
});
export type TemplateMeta = Static<typeof TemplateMetaSchema>;
