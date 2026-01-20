import type { Session } from "@opencode-ai/sdk/v2";
import { ExternalLink, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  /** Show sandbox/workspace info (for aggregated views) */
  showSandboxInfo?: boolean;
  /** Show delete button */
  showDelete?: boolean;
  /** Called when delete is clicked */
  onDelete?: (sessionId: string) => void;
  /** Whether delete is pending */
  isDeleting?: boolean;
};

export function SessionRow({
  session,
  showSandboxInfo = false,
  showDelete = false,
  onDelete,
  isDeleting,
}: SessionRowProps) {
  const sessionUrl = buildOpenCodeSessionUrl(
    session.sandbox.opencodeUrl,
    session.directory,
    session.id,
  );
  const timeString = session.time.updated || session.time.created;

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors group">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">
          {session.title || `Session ${session.id.slice(0, 8)}`}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {showSandboxInfo && (
            <>
              {session.sandbox.workspaceId && (
                <span className="truncate">{session.sandbox.workspaceId}</span>
              )}
              {!session.sandbox.workspaceId && (
                <span className="truncate">{session.sandbox.id}</span>
              )}
            </>
          )}
          {!showSandboxInfo && (
            <span className="font-mono truncate">
              {session.id.slice(0, 12)}
            </span>
          )}
          {timeString && (
            <>
              <span>•</span>
              <span>{formatRelativeTime(timeString)}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1">
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
