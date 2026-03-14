import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Building2, Plus } from "lucide-react";
import { useState } from "react";
import type { Organization } from "@/api/client";
import { organizationListQuery } from "@/api/queries";
import { CreateOrganizationDialog } from "@/components/create-organization-dialog";
import { RouteErrorComponent } from "@/components/route-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/organizations/")({
  component: OrganizationsPage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(organizationListQuery());
  },
  pendingComponent: () => (
    <div className="p-6 space-y-6">
      <Skeleton className="h-9 w-48" />
      <div className="grid gap-4">
        {[...Array(3)].map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Static skeleton placeholders never reorder
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
    </div>
  ),
  errorComponent: RouteErrorComponent,
});

function OrganizationsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const { data: organizations } = useSuspenseQuery(organizationListQuery());

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Organizations</h1>
          <p className="text-muted-foreground">
            Manage your organizations and teams
          </p>
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          className="w-full sm:w-auto"
        >
          <Plus className="h-4 w-4 mr-2" />
          New Organization
        </Button>
      </div>

      {!organizations || organizations.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground mb-4">No organizations found</p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create your first organization
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {organizations.map((organization) => (
            <OrganizationCard
              key={organization.id}
              organization={organization}
            />
          ))}
        </div>
      )}

      <CreateOrganizationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}

function OrganizationCard({ organization }: { organization: Organization }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/organizations/$orgSlug"
            params={{ orgSlug: organization.slug }}
          >
            <CardTitle className="hover:underline cursor-pointer">
              {organization.name}
            </CardTitle>
          </Link>
          {organization.personal && <Badge variant="secondary">Personal</Badge>}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Slug</span>
            <p className="font-mono text-xs mt-1">{organization.slug}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Created</span>
            <p className="mt-1">
              {new Date(organization.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
