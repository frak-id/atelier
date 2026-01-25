import type { Session } from "@opencode-ai/sdk/v2";
import { ExternalLink, Trash2 } from "lucide-react";
import {
  type SessionInteractionInfo,
  SessionStatusIndicator,
} from "@/components/session-status-indicator";
import { Button } from "@/components/ui/button";
import { useSessionInteraction } from "@/hooks/use-session-interaction";
import { buildOpenCodeSessionUrl, formatRelativeTime } from "@/lib/utils";

export type SessionWithSandboxInfo = Session & {
  sandbox: {
    id: string;
    workspaceId: string | undefined;
    opencodeUrl: string;
  };
};

type SessionRowProps = {
  session: SessionWithSandboxInfo;
  showSandboxInfo?: boolean;
  showDelete?: boolean;
  onDelete?: (sessionId: string) => void;
  isDeleting?: boolean;
  interaction?: SessionInteractionInfo | null;
  showStatus?: boolean;
};

export function SessionRow({
  session,
  showSandboxInfo = false,
  showDelete = false,
  onDelete,
  isDeleting,
  interaction: providedInteraction,
  showStatus = true,
}: SessionRowProps) {
  const sessionUrl = buildOpenCodeSessionUrl(
    session.sandbox.opencodeUrl,
    session.directory,
    session.id,
  );
  const timeString = session.time.updated || session.time.created;

  const { interaction: fetchedInteraction, isLoading } = useSessionInteraction(
    session.sandbox.opencodeUrl,
    session.id,
    showStatus && providedInteraction === undefined,
  );

  const interaction =
    providedInteraction !== undefined
      ? providedInteraction
      : fetchedInteraction;

  const needsAttention =
    interaction &&
    (interaction.pendingPermissions.length > 0 ||
      interaction.pendingQuestions.length > 0);

  const shortId = session.id.slice(0, 8);

  return (
    <div className="flex items-center gap-2 text-sm py-2 px-3 bg-muted/50 rounded-lg hover:bg-muted transition-colors group">
      <span className="truncate flex-1">
        {session.title || "Session"}{" "}
        <span className="font-mono text-muted-foreground">({shortId})</span>
        {showSandboxInfo && session.sandbox.workspaceId && (
          <span className="text-muted-foreground text-xs ml-2">
            {session.sandbox.workspaceId}
          </span>
        )}
      </span>

      {showStatus && (
        <SessionStatusIndicator
          interaction={interaction}
          isLoading={isLoading && providedInteraction === undefined}
          compact
        />
      )}

      {timeString && (
        <span className="text-muted-foreground text-xs shrink-0">
          {formatRelativeTime(timeString)}
        </span>
      )}

      <div className="flex items-center gap-1">
        {needsAttention && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            asChild
          >
            <a href={sessionUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3" />
              Respond
            </a>
          </Button>
        )}
        {!needsAttention && (
          <Button
            variant="ghost"
            size="sm"
            className="opacity-0 group-hover:opacity-100 transition-opacity"
            asChild
          >
            <a href={sessionUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        )}
        {showDelete && onDelete && (
          <Button
            variant="ghost"
            size="sm"
            className="opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => {
              if (confirm("Delete this session?")) {
                onDelete(session.id);
              }
            }}
            disabled={isDeleting}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        )}
      </div>
    </div>
  );
}
