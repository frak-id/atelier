import { Code2, ExternalLink, Github, Slack } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Common shape of "where did this resource come from" metadata, shared between:
 *   - `task.data.integration` (Task in `@frak/atelier-manager/types`)
 *   - `sandbox.origin`        (Sandbox in `@frak/atelier-manager/types`)
 *
 * Only the fields actually rendered are required here. `externalUrl` is
 * optional; when present the badge becomes a link.
 */
export type IntegrationSource = {
  source: string;
  externalUrl?: string;
};

const KNOWN_SOURCES = {
  slack: { label: "Slack", Icon: Slack },
  github: { label: "GitHub", Icon: Github },
  "opencode-plugin": { label: "OpenCode", Icon: Code2 },
} as const;

type KnownSource = keyof typeof KNOWN_SOURCES;

function isKnownSource(source: string): source is KnownSource {
  return source in KNOWN_SOURCES;
}

/**
 * Render an integration source.
 *
 *   - `variant="icon"` (default): bare icon, used inline next to a title
 *     (sandbox card / task card). Becomes an `<a>` if `externalUrl` is set.
 *   - `variant="badge"`: pill with icon + "via Slack" / "via GitHub" label.
 *   - `variant="link"`: icon + label + open-in-new-tab arrow, used in
 *     metadata sections.
 */
export function IntegrationSourceBadge({
  integration,
  variant = "icon",
}: {
  integration?: IntegrationSource | null;
  variant?: "icon" | "badge" | "link";
}) {
  if (!integration || !isKnownSource(integration.source)) return null;

  const { label, Icon } = KNOWN_SOURCES[integration.source];

  if (variant === "badge") {
    const badge = (
      <Badge variant="outline" className="gap-1 text-xs">
        <Icon className="h-3 w-3" />
        via {label}
      </Badge>
    );
    if (!integration.externalUrl) return badge;
    return (
      <a
        href={integration.externalUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:opacity-80 transition-opacity"
      >
        {badge}
      </a>
    );
  }

  if (variant === "link") {
    if (integration.externalUrl) {
      return (
        <a
          href={integration.externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
        >
          <Icon className="h-4 w-4" />
          <span>{label}</span>
          <ExternalLink className="h-3 w-3" />
        </a>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </span>
    );
  }

  // variant === "icon"
  const icon = <Icon className="h-3 w-3" />;
  const tooltip = `Created from ${label}`;

  if (integration.externalUrl) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={integration.externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            {icon}
          </a>
        </TooltipTrigger>
        <TooltipContent>
          <span>{tooltip}</span>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center text-muted-foreground shrink-0">
          {icon}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span>{tooltip}</span>
      </TooltipContent>
    </Tooltip>
  );
}
