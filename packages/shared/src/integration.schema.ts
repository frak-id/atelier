import { type Static, Type } from "@sinclair/typebox";
import { PERMISSION_RISKS, type PermissionRisk } from "./permission.ts";

/** One of `PERMISSION_RISKS` (a mapped union has no static type: Unsafe). */
const MinRiskSchema = Type.Unsafe<PermissionRisk>(
  Type.Union(PERMISSION_RISKS.map((risk) => Type.Literal(risk))),
);

/**
 * `PUT /api/integrations/:id/connection`. `credential: null` clears it. On
 * create, a credential the integration requires must be present.
 */
export const IntegrationConnectionInputSchema = Type.Object(
  {
    credential: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    ),
    enabled: Type.Optional(Type.Boolean()),
    minRisk: Type.Optional(MinRiskSchema),
    delaySeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 3600 })),
  },
  { additionalProperties: false },
);
export type IntegrationConnectionInput = Static<
  typeof IntegrationConnectionInputSchema
>;

/** The caller's connection, as the API returns it: never the credential. */
export const IntegrationConnectionViewSchema = Type.Object({
  enabled: Type.Boolean(),
  minRisk: MinRiskSchema,
  delaySeconds: Type.Integer(),
  hasCredential: Type.Boolean(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type IntegrationConnectionView = Static<
  typeof IntegrationConnectionViewSchema
>;

/** One enabled integration: its manifest, what it can do, the caller's
 * connection. */
export const IntegrationViewSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  description: Type.String(),
  docsUrl: Type.Optional(Type.String()),
  credential: Type.Optional(
    Type.Object({
      label: Type.String(),
      required: Type.Boolean(),
      help: Type.Optional(Type.String()),
    }),
  ),
  capabilities: Type.Object({ permissions: Type.Boolean() }),
  connection: Type.Union([IntegrationConnectionViewSchema, Type.Null()]),
});
export type IntegrationView = Static<typeof IntegrationViewSchema>;
