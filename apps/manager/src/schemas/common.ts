import type { Static } from "elysia";
import { t } from "elysia";

export const IdParamSchema = t.Object({
  id: t.String({ minLength: 1 }),
});
export type IdParam = Static<typeof IdParamSchema>;

export const PaginationQuerySchema = t.Object({
  page: t.Optional(t.Numeric({ minimum: 1 })),
  perPage: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
});
export type PaginationQuery = Static<typeof PaginationQuerySchema>;

export const MessageResponseSchema = t.Object({
  message: t.String(),
});
export type MessageResponse = Static<typeof MessageResponseSchema>;

export const ErrorResponseSchema = t.Object({
  error: t.String(),
});
export type ErrorResponse = Static<typeof ErrorResponseSchema>;

export const SuccessResponseSchema = t.Object({
  success: t.Boolean(),
});
export type SuccessResponse = Static<typeof SuccessResponseSchema>;
