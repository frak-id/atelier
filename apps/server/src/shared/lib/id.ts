import { customAlphabet } from "nanoid";

export const safeNanoid = customAlphabet(
  "abcdefghijklmnopqrstuvwxyz0123456789",
  12,
);
