import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Loader2, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  type OrgMemberRole,
  organizationsListQuery,
  orgMembersQuery,
  useAddOrgMember,
  useCreateOrganization,
} from "@/api/queries/organizations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";

const ROLES: OrgMemberRole[] = ["owner", "admin", "member", "viewer"];
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/;

export const Route = createFileRoute("/settings/organizations")({
  component: OrganizationsPage,
});

function OrganizationsPage() {
  const {
    data: orgs,
    isPending,
    isError,
    error,
  } = useQuery(organizationsListQuery());
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          Create organization
        </Button>
      </div>
      {isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
      ) : orgs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No organizations yet.</p>
      ) : (
        <div className="space-y-2">
          {orgs.map((org) => (
            <OrgRow key={org.id} org={org} />
          ))}
        </div>
      )}
      <CreateOrgDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function OrgRow({
  org,
}: {
  org: {
    id: string;
    name: string;
    slug: string;
    personal: boolean;
    role: OrgMemberRole;
  };
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setExpanded((open) => !open)}
            aria-label={expanded ? "Collapse members" : "Expand members"}
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </Button>
          <span className="font-medium">{org.name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {org.slug}
          </span>
          <Badge variant="secondary">{org.role}</Badge>
          {org.personal ? <Badge variant="outline">personal</Badge> : null}
        </div>
        {expanded ? <OrgMembers orgId={org.id} role={org.role} /> : null}
      </CardContent>
    </Card>
  );
}

function OrgMembers({ orgId, role }: { orgId: string; role: OrgMemberRole }) {
  const {
    data: members,
    isPending,
    isError,
  } = useQuery(orgMembersQuery(orgId));
  const [addOpen, setAddOpen] = useState(false);
  const canManage = role === "owner" || role === "admin";

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      {isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">Failed to load members.</p>
      ) : (
        members?.map((member) => (
          <div
            key={member.id}
            className="flex items-center justify-between text-sm"
          >
            <span className="truncate">{member.username}</span>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{member.role}</Badge>
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(member.joinedAt)}
              </span>
            </div>
          </div>
        ))
      )}
      {canManage ? (
        <>
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus />
            Add member
          </Button>
          <AddMemberDialog
            orgId={orgId}
            open={addOpen}
            onOpenChange={setAddOpen}
          />
        </>
      ) : null}
    </div>
  );
}

function AddMemberDialog({
  orgId,
  open,
  onOpenChange,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const addMember = useAddOrgMember(orgId);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<OrgMemberRole>("member");

  function reset() {
    setUserId("");
    setRole("member");
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!userId) return;
    addMember.mutate(
      { userId, role },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add member</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="member-user">User ID</Label>
              <Input
                id="member-user"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="member-role">Role</Label>
              <select
                id="member-role"
                value={role}
                onChange={(e) => setRole(e.target.value as OrgMemberRole)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={addMember.isPending}>
              {addMember.isPending ? (
                <Loader2 className="animate-spin" />
              ) : null}
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateOrgDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createOrg = useCreateOrganization();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const slugValid = SLUG_RE.test(slug);

  function reset() {
    setName("");
    setSlug("");
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name || !slugValid) return;
    createOrg.mutate(
      { name, slug },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create organization</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="org-name">Name</Label>
              <Input
                id="org-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="org-slug">Slug</Label>
              <Input
                id="org-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                required
                placeholder="my-org"
              />
              {slug && !slugValid ? (
                <p className="text-xs text-destructive">
                  Lowercase letters, digits and hyphens only.
                </p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createOrg.isPending || (slug.length > 0 && !slugValid)}
            >
              {createOrg.isPending ? (
                <Loader2 className="animate-spin" />
              ) : null}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
