import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  formatSessionId,
  getQuestionDisplayText,
  truncateText,
} from "@/lib/intervention-helpers";
import { cn } from "@/lib/utils";

type ExpandableInterventionsProps = {
  permissions: Array<PermissionRequest & { sessionId: string }>;
  questions: Array<QuestionRequest & { sessionId: string }>;
  compact?: boolean;
};

export function ExpandableInterventions({
  permissions,
  questions,
  compact = false,
}: ExpandableInterventionsProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const totalCount = permissions.length + questions.length;

  if (totalCount === 0) {
    return null;
  }

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <div
        className={cn(
          "border border-amber-200 bg-amber-50 rounded-md",
          compact ? "p-2" : "p-3",
        )}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity"
          >
            <AlertTriangle
              className={cn(
                "text-amber-600 shrink-0",
                compact ? "h-3 w-3" : "h-4 w-4",
              )}
            />
            <span
              className={cn(
                "font-medium text-amber-900 flex-1",
                compact ? "text-xs" : "text-sm",
              )}
            >
              {totalCount} action{totalCount !== 1 ? "s" : ""} needed
            </span>
            {isExpanded ? (
              <ChevronDown
                className={cn(
                  "text-amber-600",
                  compact ? "h-3 w-3" : "h-4 w-4",
                )}
              />
            ) : (
              <ChevronRight
                className={cn(
                  "text-amber-600",
                  compact ? "h-3 w-3" : "h-4 w-4",
                )}
              />
            )}
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className={cn("space-y-3", compact ? "mt-2" : "mt-3")}>
            {permissions.length > 0 && (
              <div>
                <h4
                  className={cn(
                    "font-semibold text-amber-900 mb-2",
                    compact ? "text-xs" : "text-sm",
                  )}
                >
                  Permissions ({permissions.length})
                </h4>
                <div className="space-y-2">
                  {permissions.map((p) => (
                    <div
                      key={p.id}
                      className={cn(
                        "flex items-start gap-2 text-amber-800",
                        compact ? "text-xs" : "text-sm",
                      )}
                    >
                      <Badge
                        variant="outline"
                        className="shrink-0 text-xs bg-white"
                      >
                        {formatSessionId(p.sessionID)}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <span className="font-medium">{p.permission}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {questions.length > 0 && (
              <div>
                <h4
                  className={cn(
                    "font-semibold text-amber-900 mb-2",
                    compact ? "text-xs" : "text-sm",
                  )}
                >
                  Questions ({questions.length})
                </h4>
                <div className="space-y-2">
                  {questions.map((q) => (
                    <div
                      key={q.id}
                      className={cn(
                        "flex items-start gap-2 text-amber-800",
                        compact ? "text-xs" : "text-sm",
                      )}
                    >
                      <Badge
                        variant="outline"
                        className="shrink-0 text-xs bg-white"
                      >
                        {formatSessionId(q.sessionID)}
                      </Badge>
                      <div className="flex-1 min-w-0 break-words">
                        {truncateText(
                          getQuestionDisplayText(q),
                          compact ? 120 : 200,
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
