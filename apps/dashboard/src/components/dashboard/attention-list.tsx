import { Link } from "@tanstack/react-router";
import { AlertCircle, ArrowRight } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { QuickActions } from "@/components/shared/quick-actions";
import { StatusIndicator } from "@/components/shared/status-indicator";
import { TimeAgo } from "@/components/shared/time-ago";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface AttentionItem {
  id: string;
  title: string;
  workspaceName?: string;
  lastMessage?: string;
  updatedAt: string;
  vscodeUrl?: string;
  opencodeUrl?: string;
  type: "task" | "session";
}

interface AttentionListProps {
  items: AttentionItem[];
  onReply?: (item: AttentionItem) => void;
}

export function AttentionList({ items, onReply }: AttentionListProps) {
  if (items.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertCircle className="h-4 w-4 text-red-500" />
            Needs Your Attention
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            title="All caught up!"
            description="No tasks or sessions need your attention right now."
            className="py-6"
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-red-500/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertCircle className="h-4 w-4 text-red-500" />
          Needs Your Attention ({items.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
          >
            <StatusIndicator status="attention" className="mt-1.5" />

            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link
                    to={item.type === "task" ? "/tasks" : "/sessions"}
                    className="font-medium hover:underline truncate block"
                  >
                    {item.title}
                  </Link>
                  {item.workspaceName && (
                    <p className="text-xs text-muted-foreground">
                      {item.workspaceName}
                    </p>
                  )}
                </div>
                <TimeAgo
                  date={item.updatedAt}
                  className="text-xs text-muted-foreground shrink-0"
                />
              </div>

              {item.lastMessage && (
                <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                  {item.lastMessage}
                </p>
              )}

              <div className="flex items-center gap-2 mt-2">
                {onReply && (
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => onReply(item)}
                  >
                    Reply
                  </Button>
                )}
                <QuickActions
                  vscodeUrl={item.vscodeUrl}
                  opencodeUrl={item.opencodeUrl}
                />
                <Link
                  to={item.type === "task" ? "/tasks" : "/sessions"}
                  className="ml-auto"
                >
                  <Button variant="ghost" size="sm">
                    View <ArrowRight className="h-3 w-3 ml-1" />
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
