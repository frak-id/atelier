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

export class ResourceExhaustedError extends SandboxError {
  constructor(resource: string) {
    super(`${resource} limit reached`, "RESOURCE_EXHAUSTED", 429);
    this.name = "ResourceExhaustedError";
  }
}
