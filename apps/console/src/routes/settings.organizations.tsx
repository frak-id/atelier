import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { currentUserQuery } from "@/api/queries/auth";
import {
  type OrgMemberRole,
  organizationsListQuery,
  orgMembersQuery,
  useAddOrgMember,
  useCreateOrganization,
  useDeleteOrganization,
  useRemoveOrgMember,
  useRenameOrganization,
  useUpdateOrgMemberRole,
} from "@/api/queries/organizations";
import { usersDirectoryQuery } from "@/api/queries/users";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { TransferResourcesDialog } from "@/components/transfer-resources-dialog";
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
import { NativeSelect } from "@/components/ui/native-select";
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
  const [transferOpen, setTransferOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setTransferOpen(true)}
        >
          <ArrowLeftRight />
          Move resources
        </Button>
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
      <TransferResourcesDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        organizations={orgs ?? []}
      />
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
    mine: boolean;
    role: OrgMemberRole;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteOrg = useDeleteOrganization();
  const canManageOrg = org.role === "owner" || org.role === "admin";

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
          {org.mine ? <Badge variant="outline">personal</Badge> : null}
          <div className="ml-auto flex shrink-0 gap-1">
            {canManageOrg ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRenameOpen(true)}
              >
                <Pencil />
                Rename
              </Button>
            ) : null}
            {org.role === "owner" && !org.personal ? (
              <Button
                variant="outline"
                size="sm"
                disabled={deleteOrg.isPending}
                onClick={() => setDeleteOpen(true)}
              >
                {deleteOrg.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Trash2 />
                )}
                Delete
              </Button>
            ) : null}
          </div>
        </div>
        {expanded ? <OrgMembers orgId={org.id} role={org.role} /> : null}
      </CardContent>
      <RenameOrgDialog
        org={org}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete organization?"
        description={
          <>
            This permanently deletes <strong>{org.name}</strong>. If it still
            owns secrets, toolboxes, or other resources, the server will refuse
            and tell you what to move first (use{" "}
            <span className="font-medium">Move resources</span> above). This
            cannot be undone.
          </>
        }
        onConfirm={() => deleteOrg.mutate(org.id)}
      />
    </Card>
  );
}

function RenameOrgDialog({
  org,
  open,
  onOpenChange,
}: {
  org: { id: string; name: string; slug: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const renameOrg = useRenameOrganization(org.id);
  const [name, setName] = useState(org.name);
  const [slug, setSlug] = useState(org.slug);
  const slugValid = SLUG_RE.test(slug);

  function reset() {
    setName(org.name);
    setSlug(org.slug);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name || !slugValid) return;
    renameOrg.mutate(
      { name, slug },
      {
        onSuccess: () => onOpenChange(false),
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
            <DialogTitle>Rename organization</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="rename-org-name">Name</Label>
              <Input
                id="rename-org-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rename-org-slug">Slug</Label>
              <Input
                id="rename-org-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                required
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
              disabled={renameOrg.isPending || (slug.length > 0 && !slugValid)}
            >
              {renameOrg.isPending ? (
                <Loader2 className="animate-spin" />
              ) : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OrgMembers({ orgId, role }: { orgId: string; role: OrgMemberRole }) {
  const {
    data: members,
    isPending,
    isError,
  } = useQuery(orgMembersQuery(orgId));
  const { data: currentUser } = useQuery(currentUserQuery());
  const [addOpen, setAddOpen] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<
    { userId: string; username: string } | undefined
  >();
  const canManage = role === "owner" || role === "admin";
  const updateRole = useUpdateOrgMemberRole(orgId);
  const removeMember = useRemoveOrgMember(orgId);
  const ownersCount = members?.filter((m) => m.role === "owner").length ?? 0;
  // Owners manage anyone; admins manage non-owners only (mirrors the
  // server's `OrgMemberService.updateRole`/`removeMember`).
  const canManageMember = (memberRole: OrgMemberRole) =>
    role === "owner" || (role === "admin" && memberRole !== "owner");
  const assignableRoles =
    role === "owner" ? ROLES : ROLES.filter((r) => r !== "owner");
  const isSoleOwner = role === "owner" && ownersCount <= 1;

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      {isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">Failed to load members.</p>
      ) : (
        members?.map((member) => {
          const isSelf = member.userId === currentUser?.id;
          const manageable = canManageMember(member.role) && !isSelf;
          return (
            <div
              key={member.id}
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
            >
              <span className="truncate">
                {member.username}
                {isSelf ? (
                  <span className="text-xs text-muted-foreground"> (you)</span>
                ) : null}
              </span>
              <div className="flex items-center gap-2">
                {manageable ? (
                  <NativeSelect
                    value={member.role}
                    onChange={(e) =>
                      updateRole.mutate({
                        userId: member.userId,
                        role: e.target.value as OrgMemberRole,
                      })
                    }
                    disabled={updateRole.isPending}
                    aria-label={`Role for ${member.username}`}
                  >
                    {assignableRoles.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <Badge variant="secondary">{member.role}</Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {formatRelativeTime(member.joinedAt)}
                </span>
                {manageable ? (
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={removeMember.isPending}
                    aria-label={`Remove ${member.username}`}
                    onClick={() =>
                      setPendingRemove({
                        userId: member.userId,
                        username: member.username,
                      })
                    }
                  >
                    <Trash2 />
                  </Button>
                ) : null}
                {isSelf && !isSoleOwner ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={removeMember.isPending}
                    onClick={() =>
                      setPendingRemove({
                        userId: member.userId,
                        username: member.username,
                      })
                    }
                  >
                    <LogOut />
                    Leave
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })
      )}
      <ConfirmDialog
        open={pendingRemove !== undefined}
        onOpenChange={(next) => {
          if (!next) setPendingRemove(undefined);
        }}
        title={
          pendingRemove?.userId === currentUser?.id
            ? "Leave organization?"
            : "Remove member?"
        }
        description={
          pendingRemove?.userId === currentUser?.id ? (
            "You'll lose access to this organization's resources."
          ) : (
            <>
              This removes <strong>{pendingRemove?.username}</strong> from the
              organization.
            </>
          )
        }
        confirmLabel={
          pendingRemove?.userId === currentUser?.id ? "Leave" : "Remove"
        }
        onConfirm={() => {
          if (!pendingRemove) return;
          removeMember.mutate({
            userId: pendingRemove.userId,
            isSelf: pendingRemove.userId === currentUser?.id,
          });
        }}
      />
      {canManage ? (
        <>
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus />
            Add member
          </Button>
          <AddMemberDialog
            orgId={orgId}
            roles={assignableRoles}
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
  roles,
  open,
  onOpenChange,
}: {
  orgId: string;
  /** Roles the caller may grant (admins can't add owners). */
  roles: OrgMemberRole[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const addMember = useAddOrgMember(orgId);
  const { data: users, isPending: usersPending } = useQuery(
    usersDirectoryQuery(),
  );
  const { data: members, isPending: membersPending } = useQuery(
    orgMembersQuery(orgId),
  );
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<OrgMemberRole>("member");

  const memberIds = new Set(members?.map((m) => m.userId) ?? []);
  const candidates = (users ?? []).filter((user) => !memberIds.has(user.id));

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
              <Label htmlFor="member-user">User</Label>
              {usersPending || membersPending ? (
                <Skeleton className="h-9 w-full" />
              ) : candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Every registered user is already a member.
                </p>
              ) : (
                <NativeSelect
                  id="member-user"
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  autoFocus
                >
                  <option value="" disabled>
                    Select a user…
                  </option>
                  {candidates.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.username} ({user.email})
                    </option>
                  ))}
                </NativeSelect>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="member-role">Role</Label>
              <NativeSelect
                id="member-role"
                value={role}
                onChange={(e) => setRole(e.target.value as OrgMemberRole)}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </NativeSelect>
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
            <Button type="submit" disabled={addMember.isPending || !userId}>
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
