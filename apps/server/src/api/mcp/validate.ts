/**
 * TypeBox boundary validation for MCP tool inputs. MCP tools accept loose
 * `z.record(z.string(), z.unknown())` payloads (the MCP SDK speaks Zod), but
 * the services expect the `@atelier/spec` TypeBox-validated shapes the HTTP
 * routes get from Elysia's schema guards. Validate explicitly at the same
 * boundary instead of blind `as` casts, using the workspace's single
 * typebox instance (the same one Elysia peer-depends on).
 */
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "../../shared/errors.ts";

export function parseSpec<S extends TSchema>(
  schema: S,
  value: unknown,
  label: string,
): Static<S> {
  if (Value.Check(schema, value)) return value as Static<S>;
  const first = Value.Errors(schema, value).First();
  throw new ValidationError(
    first
      ? `invalid ${label}: ${first.path || "/"} ${first.message}`
      : `invalid ${label}`,
  );
}
