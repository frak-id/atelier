import { Code2, Github, Slack } from "lucide-react";
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

export function IntegrationSourceBadge({
  integration,
}: {
  integration?: IntegrationSource | null;
}) {
  if (!integration || !isKnownSource(integration.source)) return null;

  const { label, Icon } = KNOWN_SOURCES[integration.source];
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
