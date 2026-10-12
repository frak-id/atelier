import { type Static, Type } from "@sinclair/typebox";

/** How risky an agent permission prompt looks, lowest first. */
export const PERMISSION_RISKS = ["low", "medium", "high"] as const;
export type PermissionRisk = (typeof PERMISSION_RISKS)[number];
/**
 * Humanise and classify a permission prompt by its free-text label (an ACP
 * tool-call title/kind, e.g. "Edit file", "bash", "webfetch"): there is no
 * fixed enum, so a keyword heuristic. Unknown labels keep their verbatim
 * label at `medium`, never under-warned. One rule for the console's risk
 * badge and the Steery notifier's `minRisk`.
 */
export function permissionPresentation(permission: string): {
  /** Plain-language label — what the agent wants to do. */
  what: string;
  risk: PermissionRisk;
  riskLabel: string;
} {
  const lower = permission.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => lower.includes(n));
  if (has("delete", "remove", "rm ")) {
    return { what: "Delete files", risk: "high", riskLabel: "Destructive" };
  }
  if (has("exec", "bash", "shell", "run")) {
    return { what: "Run a command", risk: "high", riskLabel: "Runs code" };
  }
  if (has("write", "edit", "patch", "create")) {
    return { what: "Edit files", risk: "medium", riskLabel: "Changes files" };
  }
  if (has("fetch", "network", "http", "web")) {
    return {
      what: "Access the network",
      risk: "medium",
      riskLabel: "Network access",
    };
  }
  if (has("read", "view", "list")) {
    return { what: "Read files", risk: "low", riskLabel: "Read-only" };
  }
  return { what: permission, risk: "medium", riskLabel: "Unrecognised" };
}

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
