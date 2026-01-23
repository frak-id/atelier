import { createFileRoute } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";

export const Route = createFileRoute("/sessions/")({
  component: SessionsPage,
});

function SessionsPage() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Sessions"
        description="All active OpenCode sessions across sandboxes"
      />

      <Card>
        <CardContent className="py-12 text-center">
          <MessageSquare className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">
            Sessions View Coming Soon
          </h3>
          <p className="text-muted-foreground max-w-md mx-auto">
            This view will show all active sessions with real-time status
            updates, grouped by attention state. Check back after Phase 2 is
            complete.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
