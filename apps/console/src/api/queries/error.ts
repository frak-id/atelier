/** Best-effort extraction of a message from Eden's error envelope. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "value" in error) {
    const { value } = error;
    if (value && typeof value === "object" && "message" in value) {
      const { message } = value;
      if (typeof message === "string") return message;
    }
  }
  return fallback;
}
