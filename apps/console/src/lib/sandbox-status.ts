import type { SandboxStatus } from "@atelier/spec";
import type { BadgeVariant } from "@/components/ui/badge";

const STATUS_PRESENTATION: Record<
  SandboxStatus,
  { label: string; variant: BadgeVariant }
> = {
  creating: { label: "Creating", variant: "warning" },
  running: { label: "Running", variant: "success" },
  paused: { label: "Paused", variant: "secondary" },
  stopped: { label: "Stopped", variant: "outline" },
  error: { label: "Error", variant: "danger" },
};

/** Falls back to a neutral badge if the server ever ships a status this
 * build doesn't know about — never crash the fleet list over a new enum. */
export function sandboxStatusPresentation(status: SandboxStatus): {
  label: string;
  variant: BadgeVariant;
} {
  return STATUS_PRESENTATION[status] ?? { label: status, variant: "outline" };
}

export const HARNESS_ANNOTATION_KEY = "atelier.dev/harness";

export function harnessFromAnnotations(
  annotations: Record<string, string> | undefined,
): string | undefined {
  return annotations?.[HARNESS_ANNOTATION_KEY];
}
