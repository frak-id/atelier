/** An API failure carrying the HTTP status of the response. */
export class ApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Best-effort extraction of a message from Eden's error envelope. */
function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "value" in error) {
    const { value } = error;
    if (value && typeof value === "object" && "message" in value) {
      const { message } = value;
      if (typeof message === "string") return message;
    }
  }
  return fallback;
}

type EdenResult = { data: unknown; error: unknown };

/**
 * Unwrap an Eden response: return its typed `data`, or throw an
 * {@link ApiError} (server message when there is one, else `fallback`).
 */
export function unwrap<R extends EdenResult>(
  response: R,
  fallback: string,
): Extract<R, { error: null }>["data"] {
  if (response.error) {
    const { status } = response.error as { status?: number };
    throw new ApiError(errorMessage(response.error, fallback), status);
  }
  return response.data as Extract<R, { error: null }>["data"];
}
