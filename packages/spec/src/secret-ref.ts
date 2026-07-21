import { type Static, Type } from "@sinclair/typebox";

/**
 * A secret *reference*, the only way a secret is allowed to appear in a spec
 * at rest. Control substitutes these with real values at the seam crossing;
 * the runtime rejects any spec that still contains one.
 *
 * JSON-typed (not `${…}` string templating) so it is greppable and impossible
 * to half-interpolate. See atelier-v2 §2 "Secret references have one syntax".
 */
export const SecretRefSchema = Type.Object(
  {
    $secret: Type.String({
      description: "Name of the secret to resolve in the control layer.",
    }),
  },
  {
    additionalProperties: false,
    $id: "SecretRef",
    description: "An unresolved reference to a control-layer secret value.",
  },
);

export type SecretRef = Static<typeof SecretRefSchema>;

/** A string that may still be an unresolved secret reference (spec-at-rest). */
export const MaybeSecretStringSchema = Type.Union([
  Type.String(),
  SecretRefSchema,
]);

export type MaybeSecretString = Static<typeof MaybeSecretStringSchema>;

export function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "$secret" in value &&
    typeof (value as { $secret: unknown }).$secret === "string"
  );
}
