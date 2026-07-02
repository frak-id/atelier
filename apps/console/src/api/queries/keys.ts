/**
 * Central query-key registry. Each domain query module references these so
 * mutations can invalidate precisely.
 */
export const queryKeys = {
  auth: {
    me: ["auth", "me"] as const,
  },
} as const;
