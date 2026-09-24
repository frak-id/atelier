import { Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { launchpadStarterFromAnnotations } from "@/lib/sandbox-status";

/**
 * Marks a Launchpad workspace in the developer console, so a pause or a
 * destroy here is known to land on a teammate's workspace. `link` opens it
 * on the Launchpad (only its launcher can: the page 404s for anyone else).
 */
export function LaunchpadBadge({
  sandboxId,
  annotations,
  link = false,
}: {
  sandboxId: string;
  annotations: Record<string, string> | undefined;
  link?: boolean;
}) {
  const starterId = launchpadStarterFromAnnotations(annotations);
  if (!starterId) return null;
  const badge = (
    <Badge
      variant="outline"
      className="gap-1"
      title={`A Launchpad workspace (starter ${starterId})`}
    >
      <Sparkles className="size-3" />
      Launchpad
    </Badge>
  );
  if (!link) return badge;
  return (
    <Link
      to="/launchpad/w/$workspaceId"
      params={{ workspaceId: sandboxId }}
      aria-label="Open this workspace on the Launchpad"
      className="rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      {badge}
    </Link>
  );
}
