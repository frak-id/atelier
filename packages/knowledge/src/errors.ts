/**
 * Knowledge errors carry a stable `code` so an HTTP/MCP shell can map them
 * (not_found → 404, forbidden → 403, invalid → 400, conflict → 409)
 * without importing classes.
 */
export type KnowledgeErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid"
  | "conflict";

export class KnowledgeError extends Error {
  constructor(
    readonly code: KnowledgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}

export class NotFoundError extends KnowledgeError {
  constructor(what: string, id: string) {
    super("not_found", `${what} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

/** The actor may not perform this action (e.g. an agent approving). */
export class ForbiddenError extends KnowledgeError {
  constructor(message: string) {
    super("forbidden", message);
    this.name = "ForbiddenError";
  }
}

export class ValidationError extends KnowledgeError {
  constructor(message: string) {
    super("invalid", message);
    this.name = "ValidationError";
  }
}

/** A lifecycle transition that isn't allowed from the current status. */
export class InvalidTransitionError extends KnowledgeError {
  constructor(id: string, from: string, action: string) {
    super("conflict", `cannot ${action} memory ${id} in status ${from}`);
    this.name = "InvalidTransitionError";
  }
}
