import type { Static } from "elysia";
import { t } from "elysia";
import { SessionTemplateModelSchema } from "./session-template.ts";

export const SystemModelRefSchema = t.Union([
  SessionTemplateModelSchema,
  t.Null(),
]);
export type SystemModelRef = Static<typeof SystemModelRefSchema>;

export const SystemModelConfigSchema = t.Object({
  default: SystemModelRefSchema,
  title: SystemModelRefSchema,
  description: SystemModelRefSchema,
  dispatcher: SystemModelRefSchema,
});
export type SystemModelConfig = Static<typeof SystemModelConfigSchema>;
