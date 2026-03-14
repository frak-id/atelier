import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  Loader2,
  Plus,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useState } from "react";
import type { OrgMember, OrgMemberRole } from "@/api/client";
import {
  organizationDetailQuery,
  organizationMembersQuery,
  useAddOrgMember,
  useDeleteOrganization,
  useRemoveOrgMember,
  useUpdateOrganization,
  useUpdateOrgMemberRole,
} from "@/api/queries";
import { RouteErrorComponent } from "@/components/route-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate } from "@/lib/utils";

export const Route = createFileRoute("/organizations/$orgSlug")({
  component: OrganizationDetailPage,
  loader: ({ context, params }) => {
    context.queryClient.ensureQueryData(
      organizationDetailQuery(params.orgSlug),
    );
    context.queryClient.ensureQueryData(
      organizationMembersQuery(params.orgSlug),
    );
  },
  pendingComponent: () => (
    <div className="p-6 space-y-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-64" />
    </div>
  ),
  errorComponent: RouteErrorComponent,
});

function OrganizationDetailPage() {
  const { orgSlug } = Route.useParams();
  const navigate = useNavigate();
  const { data: org } = useSuspenseQuery(organizationDetailQuery(orgSlug));
  const { data: members } = useSuspenseQuery(organizationMembersQuery(orgSlug));

  const deleteMutation = useDeleteOrganization();

  if (!org) {
    return <div>Organization not found</div>;
  }

  const handleDelete = () => {
    if (confirm(`Delete organization "${org.name}"? This cannot be undone.`)) {
      deleteMutation.mutate(orgSlug, {
        onSuccess: () => navigate({ to: "/organizations" }),
      });
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/organizations">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center shrink-0">
              {org.avatarUrl ? (
                <img
                  src={org.avatarUrl}
                  alt={org.name}
                  className="h-10 w-10 rounded-md"
                />
              ) : org.personal ? (
                <User className="h-5 w-5 text-muted-foreground" />
              ) : (
                <Building2 className="h-5 w-5 text-muted-foreground" />
              )}
            </div>
            <div>
              <h1 className="text-3xl font-bold">{org.name}</h1>
              <p className="text-sm text-muted-foreground">{org.slug}</p>
            </div>
            {org.personal && <Badge variant="secondary">Personal</Badge>}
          </div>
        </div>
      </div>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="members">
            Members ({members?.length ?? 0})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-6">
          <GeneralTab org={org} />
        </TabsContent>

        <TabsContent value="members" className="mt-6">
          <MembersTab orgSlug={orgSlug} members={members ?? []} />
        </TabsContent>
      </Tabs>

      {!org.personal && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-destructive flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Danger Zone
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium">Delete this organization</p>
                <p className="text-sm text-muted-foreground">
                  Once deleted, this organization and all its associations
                  cannot be recovered.
                </p>
              </div>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
                className="shrink-0"
              >
                {deleteMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 mr-2" />
                )}
                Delete Organization
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function GeneralTab({
  org,
}: {
  org: {
    id: string;
    name: string;
    slug: string;
    personal: boolean;
    createdAt: string;
    updatedAt: string;
  };
}) {
  const [name, setName] = useState(org.name);
  const updateMutation = useUpdateOrganization();
  const hasChanges = name !== org.name;

  const handleSave = () => {
    if (!hasChanges) return;
    updateMutation.mutate({
      slug: org.slug,
      data: { name: name.trim() },
    });
  };

  return (
    <div className="space-y-6 max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle>Organization Settings</CardTitle>
          <CardDescription>Manage your organization details</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="org-name">Name</Label>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={org.personal}
            />
            {org.personal && (
              <p className="text-xs text-muted-foreground">
                Personal organization name cannot be changed.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Slug</Label>
            <Input value={org.slug} disabled />
            <p className="text-xs text-muted-foreground">
              Organization slug cannot be changed.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Created</Label>
            <p className="text-sm text-muted-foreground">
              {formatDate(org.createdAt)}
            </p>
          </div>

          <div className="space-y-2">
            <Label>Last Updated</Label>
            <p className="text-sm text-muted-foreground">
              {formatDate(org.updatedAt)}
            </p>
          </div>

          {!org.personal && (
            <Button
              onClick={handleSave}
              disabled={!hasChanges || updateMutation.isPending}
            >
              {updateMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const ROLE_VARIANTS: Record<string, string> = {
  owner: "default",
  admin: "secondary",
  member: "outline",
  viewer: "outline",
};

function MembersTab({
  orgSlug,
  members,
}: {
  orgSlug: string;
  members: OrgMember[];
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Members ({members.length})</CardTitle>
          <CardDescription>
            People with access to this organization
          </CardDescription>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="text-muted-foreground">No members yet.</p>
          ) : (
            <div className="space-y-2">
              {members.map((member) => (
                <MemberRow key={member.id} member={member} orgSlug={orgSlug} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AddMemberCard orgSlug={orgSlug} />
    </div>
  );
}

function MemberRow({
  member,
  orgSlug,
}: {
  member: OrgMember;
  orgSlug: string;
}) {
  const updateRole = useUpdateOrgMemberRole();
  const removeMember = useRemoveOrgMember();

  const handleRoleChange = (role: string) => {
    updateRole.mutate({
      slug: orgSlug,
      memberId: member.id,
      role: role as OrgMemberRole,
    });
  };

  const handleRemove = () => {
    if (confirm(`Remove ${member.username} from this organization?`)) {
      removeMember.mutate({ slug: orgSlug, memberId: member.id });
    }
  };

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors">
      <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0 overflow-hidden">
        {member.avatarUrl ? (
          <img
            src={member.avatarUrl}
            alt={member.username}
            className="h-8 w-8 rounded-full"
          />
        ) : (
          <span className="text-sm font-medium text-muted-foreground">
            {member.username[0]?.toUpperCase()}
          </span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{member.username}</p>
        <p className="text-xs text-muted-foreground">
          Joined {formatDate(member.joinedAt)}
        </p>
      </div>

      <Select value={member.role} onValueChange={handleRoleChange}>
        <SelectTrigger className="w-28 h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="owner">Owner</SelectItem>
          <SelectItem value="admin">Admin</SelectItem>
          <SelectItem value="member">Member</SelectItem>
          <SelectItem value="viewer">Viewer</SelectItem>
        </SelectContent>
      </Select>

      <Badge
        variant={
          ROLE_VARIANTS[member.role] as "default" | "secondary" | "outline"
        }
        className="hidden"
      >
        {member.role}
      </Badge>

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground hover:text-destructive"
        onClick={handleRemove}
        disabled={removeMember.isPending}
      >
        {removeMember.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <X className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
}

function AddMemberCard({ orgSlug }: { orgSlug: string }) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<OrgMemberRole>("member");
  const addMember = useAddOrgMember();

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim()) return;

    addMember.mutate(
      { slug: orgSlug, data: { userId: userId.trim(), role } },
      {
        onSuccess: () => {
          setUserId("");
          setRole("member");
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plus className="h-5 w-5" />
          Add Member
        </CardTitle>
        <CardDescription>
          Add a user to this organization by their user ID
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleAdd} className="flex items-end gap-3">
          <div className="flex-1 space-y-2">
            <Label htmlFor="user-id">User ID</Label>
            <Input
              id="user-id"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="GitHub user ID"
              required
            />
          </div>

          <div className="space-y-2">
            <Label>Role</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as OrgMemberRole)}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button
            type="submit"
            disabled={addMember.isPending || !userId.trim()}
          >
            {addMember.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Plus className="h-4 w-4 mr-2" />
            )}
            Add
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
