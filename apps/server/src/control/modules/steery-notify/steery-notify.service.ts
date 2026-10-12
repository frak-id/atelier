import {
  DEFAULT_STEERY_NOTIFY_POLICY,
  PERMISSION_RISKS,
  permissionPresentation,
  type SteeryNotifyMode,
  type SteeryNotifyPolicy,
} from "@frak/atelier-shared";
import type { SteeryNotifyRepository } from "./steery-notify.repository.ts";

/** Whether a permission prompt goes to Steery under `policy`, with `mode`
 * (the org's, or a sandbox's annotation override). `tools` match the ACP
 * tool kind or the prompt title, case-insensitively. */
export function notifies(
  policy: SteeryNotifyPolicy,
  mode: SteeryNotifyMode,
  prompt: { title: string; kind?: string },
): boolean {
  if (mode === "off") return false;
  const names = [prompt.title, prompt.kind ?? ""].map((n) => n.toLowerCase());
  if (
    policy.tools.length > 0 &&
    !policy.tools.some((tool) => names.includes(tool.toLowerCase()))
  ) {
    return false;
  }
  if (mode === "all") return true;
  const { risk } = permissionPresentation(prompt.title);
  return (
    PERMISSION_RISKS.indexOf(risk) >= PERMISSION_RISKS.indexOf(policy.minRisk)
  );
}

/** Per-org Steery notifier policy; an org that never set one gets the
 * default (`mode: off`). */
export class SteeryNotifyService {
  constructor(private readonly repository: SteeryNotifyRepository) {}

  get(orgId: string): SteeryNotifyPolicy {
    return this.repository.get(orgId) ?? DEFAULT_STEERY_NOTIFY_POLICY;
  }

  set(orgId: string, policy: SteeryNotifyPolicy): SteeryNotifyPolicy {
    this.repository.set(orgId, policy);
    return policy;
  }
}
