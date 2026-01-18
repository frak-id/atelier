export class SandboxError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export class NotFoundError extends SandboxError {
  constructor(resource: string, id: string) {
    super(`${resource} '${id}' not found`, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends SandboxError {
  constructor(message: string) {
    super(message, "CONFLICT", 409);
    this.name = "ConflictError";
  }
}

export class ValidationError extends SandboxError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}

export class ServiceUnavailableError extends SandboxError {
  constructor(service: string) {
    super(`${service} is unavailable`, "SERVICE_UNAVAILABLE", 503);
    this.name = "ServiceUnavailableError";
  }
}

export class ResourceExhaustedError extends SandboxError {
  constructor(resource: string) {
    super(`${resource} limit reached`, "RESOURCE_EXHAUSTED", 429);
    this.name = "ResourceExhaustedError";
  }
}

export class UnauthorizedError extends SandboxError {
  constructor(message: string) {
    super(message, "UNAUTHORIZED", 401);
    this.name = "UnauthorizedError";
  }
}
