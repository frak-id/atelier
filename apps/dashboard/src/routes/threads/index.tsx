import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { useState } from "react";
import { slackThreadListQuery } from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatRelativeTime } from "@/lib/utils";

export const Route = createFileRoute("/threads/")({
  component: ThreadsPage,
});

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-500/10 text-gray-600 border-gray-500/20",
  spawning: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  active: "bg-green-500/10 text-green-600 border-green-500/20",
  ended: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  error: "bg-red-500/10 text-red-600 border-red-500/20",
};

function ThreadsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const { data: threads, isLoading } = useQuery(slackThreadListQuery);

  const filtered =
    statusFilter === "all"
      ? (threads ?? [])
      : (threads ?? []).filter((t) => t.status === statusFilter);

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-64 bg-muted rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Slack Threads</h1>
        <p className="text-muted-foreground">
          Track Slack-initiated sandbox sessions
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="spawning">Spawning</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="ended">Ended</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">
          {filtered.length} thread{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <MessageSquare className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="text-muted-foreground">No Slack threads yet</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((thread) => (
            <Card key={thread.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm font-mono truncate">
                    #{thread.channelId}
                  </CardTitle>
                  <Badge
                    className={
                      STATUS_COLORS[thread.status] ?? STATUS_COLORS.pending
                    }
                  >
                    {thread.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {thread.initialMessage.slice(0, 100)}
                  {thread.initialMessage.length > 100 ? "..." : ""}
                </p>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {thread.branchName && (
                    <span className="font-mono bg-muted px-1.5 py-0.5 rounded truncate max-w-[200px]">
                      {thread.branchName}
                    </span>
                  )}
                  {thread.userName && <span>{thread.userName}</span>}
                  <span>{formatRelativeTime(thread.createdAt)}</span>
                </div>
                {thread.sandboxId && (
                  <div className="text-xs text-muted-foreground">
                    Sandbox:{" "}
                    <span className="font-mono">{thread.sandboxId}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
