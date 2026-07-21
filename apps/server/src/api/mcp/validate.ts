/**
 * TypeBox boundary validation for MCP tool inputs. MCP tools accept loose
 * `z.record(z.string(), z.unknown())` payloads (the MCP SDK speaks Zod), but
 * the services expect the `@atelier/spec` shapes the HTTP routes get from
 * Elysia's schema guards. Validate through elysia's own re-exported
 * validator machinery (`getSchemaValidator`) so both surfaces run the same
 * compiled TypeCheck — no direct typebox dependency needed.
 */

import type { Static, TSchema } from "elysia";
import { getSchemaValidator } from "elysia";
import { ValidationError } from "../../shared/errors.ts";

const validators = new Map<TSchema, ReturnType<typeof getSchemaValidator>>();

export function parseSpec<S extends TSchema>(
  schema: S,
  value: unknown,
  label: string,
): Static<S> {
  let validator = validators.get(schema);
  if (!validator) {
    validator = getSchemaValidator(schema);
    validators.set(schema, validator);
  }
  const result = validator.safeParse(value);
  if (result.success) return result.data as Static<S>;
  const first = result.errors[0];
  throw new ValidationError(
    first
      ? `invalid ${label}: ${first.path || "/"} ${first.summary ?? first.message}`
      : `invalid ${label}: ${result.error ?? "validation failed"}`,
  );
}
