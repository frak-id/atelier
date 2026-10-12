import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plug } from "lucide-react";
import { integrationsListQuery } from "@/api/queries/integrations";
import { IntegrationCard } from "@/components/integrations/integration-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/settings/integrations")({
  component: IntegrationsPage,
});

function IntegrationsPage() {
  const {
    data: integrations,
    isPending,
    isError,
    error,
    refetch,
  } = useQuery(integrationsListQuery());

  if (isPending) return <Skeleton className="h-24 w-full" />;
  if (isError) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (integrations.length === 0) {
    return (
      <EmptyState
        icon={Plug}
        title="No integrations are enabled on this server"
        description="Operators enable them with ATELIER_INTEGRATION_<ID>=true."
      />
    );
  }
  return (
    <div className="space-y-3">
      {integrations.map((integration) => (
        <IntegrationCard key={integration.id} integration={integration} />
      ))}
    </div>
  );
}
