import { type Static, Type } from "@sinclair/typebox";

/** Annotation overriding the org's notifier `mode` for one sandbox. */
export const STEERY_NOTIFY_ANNOTATION = "atelier.dev/steery-notify";

/** Org secret holding the Steery API key the notifier raises requests with. */
export const STEERY_API_KEY_SECRET = "STEERY_API_KEY";

export const SteeryNotifyModeSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("all"),
  Type.Literal("risky"),
]);
export type SteeryNotifyMode = Static<typeof SteeryNotifyModeSchema>;

/**
 * Per-org policy for asking a person's phone (Steery) to answer an agent's
 * permission prompt. `risky` asks only for prompts at or above `minRisk`;
 * `delaySeconds` waits that long for the console to answer first; `tools`
 * (tool kinds or titles) narrows which prompts qualify, empty = all.
 */
export const SteeryNotifyPolicySchema = Type.Object(
  {
    mode: SteeryNotifyModeSchema,
    minRisk: Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
    ]),
    delaySeconds: Type.Integer({ minimum: 0, maximum: 3600 }),
    tools: Type.Array(Type.String()),
    steeryUrl: Type.String({ pattern: "^https?://" }),
  },
  { additionalProperties: false, $id: "SteeryNotifyPolicy" },
);
export type SteeryNotifyPolicy = Static<typeof SteeryNotifyPolicySchema>;

export const DEFAULT_STEERY_NOTIFY_POLICY: SteeryNotifyPolicy = {
  mode: "off",
  minRisk: "high",
  delaySeconds: 0,
  tools: [],
  steeryUrl: "https://steery.dev",
};
