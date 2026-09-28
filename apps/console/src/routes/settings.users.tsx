import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Users as UsersIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { currentUserQuery } from "@/api/queries/auth";
import { usersDirectoryQuery } from "@/api/queries/users";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";

export const Route = createFileRoute("/settings/users")({
  component: UsersPage,
});

function UsersPage() {
  const {
    data: users,
    isPending,
    isError,
    error,
  } = useQuery(usersDirectoryQuery());
  const { data: currentUser } = useQuery(currentUserQuery());
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!users) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return users;
    return users.filter(
      (user) =>
        user.username.toLowerCase().includes(needle) ||
        user.email.toLowerCase().includes(needle),
    );
  }, [users, filter]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by username or email"
          className="sm:max-w-xs"
        />
        {users ? (
          <span className="text-sm text-muted-foreground">
            {filtered.length} of {users.length} user
            {users.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      {isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title="No users"
          description={
            users && users.length > 0
              ? "No users match this filter."
              : "No registered users yet."
          }
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              isYou={user.id === currentUser?.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UserRow({
  user,
  isYou,
}: {
  user: {
    id: string;
    username: string;
    email: string;
    avatarUrl?: string;
    personalOrgId?: string;
    createdAt: string;
    lastLoginAt: string;
    organizations: {
      id: string;
      name: string;
      slug: string;
      personal: boolean;
      role: string;
    }[];
  };
  isYou: boolean;
}) {
  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=""
              className="size-6 shrink-0 rounded-full"
            />
          ) : null}
          <span className="font-medium">{user.username}</span>
          {isYou ? <Badge variant="secondary">you</Badge> : null}
          <span className="truncate text-sm text-muted-foreground">
            {user.email}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{user.id}</span>
          <span title={user.createdAt}>
            joined {formatRelativeTime(user.createdAt)}
          </span>
          <span title={user.lastLoginAt}>
            last login {formatRelativeTime(user.lastLoginAt)}
          </span>
        </div>
        {user.organizations.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {user.organizations.map((org) => (
              <Badge
                key={org.id}
                variant={org.personal ? "outline" : "secondary"}
              >
                {org.name} · {org.role}
              </Badge>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
