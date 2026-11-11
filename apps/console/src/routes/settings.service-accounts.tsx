import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { organizationsListQuery } from "@/api/queries/organizations";
import {
  serviceAccountKeysQuery,
  serviceAccountsListQuery,
  useCheckServiceAccountGithub,
  useCreateServiceAccount,
  useCreateServiceAccountKey,
  useDeleteServiceAccount,
  useRevokeServiceAccountKey,
  useUpdateServiceAccount,
} from "@/api/queries/service-accounts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAdminStatus } from "@/hooks/use-is-admin";
import { formatRelativeTime } from "@/lib/formatters";
import {
  createBody,
  emptyForm,
  formFromAccount,
  type GithubChoice,
  githubSummaryText,
  type ServiceAccountForm,
  type ServiceAccountRole,
  updateBody,
  validateForm,
} from "@/lib/service-accounts";

export const Route = createFileRoute("/settings/service-accounts")({
  component: ServiceAccountsPage,
});

type Account = NonNullable<
  ReturnType<typeof useServiceAccounts>["data"]
>[number];

function useServiceAccounts() {
  return useQuery(serviceAccountsListQuery());
}

function ServiceAccountsPage() {
  const { isAdmin, isPending } = useAdminStatus();

  if (isPending) return <Skeleton className="h-16 w-full" />;
  if (!isAdmin) {
    return (
      <p className="text-sm text-muted-foreground">
        Only server admins can manage service accounts.
      </p>
    );
  }
  // The list is only requested once the user is known to be an admin.
  return <AdminServiceAccounts />;
}

function AdminServiceAccounts() {
  const { data: accounts, isPending, isError, error } = useServiceAccounts();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Non-human users that agents act as through /mcp. They cannot sign in.
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          Create service account
        </Button>
      </div>
      {isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No service accounts"
          description="Create one to let an agent act on its own."
        />
      ) : (
        <div className="space-y-2">
          {accounts.map((account) => (
            <AccountCard key={account.id} account={account} />
          ))}
        </div>
      )}
      {createOpen ? (
        <AccountFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          account={null}
        />
      ) : null}
    </div>
  );
}

function AccountCard({ account }: { account: Account }) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const deleteAccount = useDeleteServiceAccount();
  const check = useCheckServiceAccountGithub(account.id);
  const managed = account.managedBy === "config";
  const resetCheck = check.reset;
  const githubSummary = githubSummaryText(account.github);
  const keysId = `sa-keys-${account.id}`;

  // A result tested against the previous credential must not outlive it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on change
  useEffect(() => {
    resetCheck();
  }, [githubSummary, resetCheck]);

  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{account.name}</span>
          <span className="font-mono text-sm text-muted-foreground">
            {account.username}
          </span>
          {managed ? <Badge variant="outline">Managed by config</Badge> : null}
          <div className="ml-auto flex items-center gap-2">
            {account.github.kind === "app" ? (
              <Button
                size="sm"
                variant="outline"
                loading={check.isPending}
                onClick={() => check.mutate()}
              >
                Test connection
              </Button>
            ) : null}
            {managed ? null : (
              <>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => setEditOpen(true)}
                  aria-label={`Edit ${account.name}`}
                >
                  <Pencil />
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => setDeleteOpen(true)}
                  aria-label={`Delete ${account.name}`}
                >
                  <Trash2 />
                </Button>
              </>
            )}
          </div>
        </div>
        {account.description ? (
          <p className="text-sm text-muted-foreground">{account.description}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {account.org?.name ?? account.orgId} · {account.role ?? "no role"}
          </span>
          <span>{githubSummaryText(account.github)}</span>
          <span>
            {account.sandboxCount} sandbox
            {account.sandboxCount === 1 ? "" : "es"}
          </span>
          <span title={account.createdAt}>
            created {formatRelativeTime(account.createdAt)}
          </span>
        </div>
        {managed ? (
          <p className="text-xs text-muted-foreground">
            Declared in sandbox.config.json.
          </p>
        ) : null}
        {check.isError ? (
          <p className="text-sm text-destructive">{check.error.message}</p>
        ) : null}
        {check.data ? <CheckResult result={check.data} /> : null}
        <button
          type="button"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setKeysOpen((open) => !open)}
          aria-expanded={keysOpen}
          aria-controls={keysId}
        >
          {keysOpen ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
          API keys
        </button>
        {keysOpen ? <KeysSection id={keysId} accountId={account.id} /> : null}
      </CardContent>
      {editOpen ? (
        <AccountFormDialog
          open={editOpen}
          onOpenChange={(next) => {
            setEditOpen(next);
            // A save may have replaced the credential (e.g. a new token).
            if (!next) resetCheck();
          }}
          account={account}
        />
      ) : null}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete service account?"
        description={
          <>
            <span className="font-mono">{account.username}</span> and its API
            keys will be removed. This cannot be undone.
          </>
        }
        onConfirm={() => deleteAccount.mutateAsync(account.id)}
      />
    </Card>
  );
}

function CheckResult({
  result,
}: {
  result: {
    identity: { name: string; email: string };
    expiresAt: number;
    permissions: Record<string, string>;
    repositories?: string[];
  };
}) {
  const permissions = Object.entries(result.permissions);
  return (
    <dl className="space-y-1 rounded-md bg-muted p-2 text-xs">
      <div>
        <dt className="inline text-muted-foreground">Identity: </dt>
        <dd className="inline">
          {result.identity.name} &lt;{result.identity.email}&gt;
        </dd>
      </div>
      <div>
        <dt className="inline text-muted-foreground">Token expires: </dt>
        <dd className="inline">
          {new Date(result.expiresAt).toLocaleString()}
        </dd>
      </div>
      <div>
        <dt className="inline text-muted-foreground">Permissions: </dt>
        <dd className="inline">
          {permissions.length > 0
            ? permissions.map(([name, level]) => `${name}:${level}`).join(", ")
            : "none"}
        </dd>
      </div>
      <div>
        <dt className="inline text-muted-foreground">Repositories: </dt>
        <dd className="inline">
          {result.repositories && result.repositories.length > 0
            ? result.repositories.join(", ")
            : "all in the installation"}
        </dd>
      </div>
    </dl>
  );
}

function AccountFormDialog({
  open,
  onOpenChange,
  account,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: Account | null;
}) {
  const editing = account !== null;
  const createAccount = useCreateServiceAccount();
  const updateAccount = useUpdateServiceAccount(account?.id ?? "");
  const { data: orgs } = useQuery(organizationsListQuery());
  const teamOrgs = (orgs ?? []).filter((org) => !org.personal);
  const [form, setForm] = useState<ServiceAccountForm>(() =>
    account ? formFromAccount(account) : emptyForm(),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const pending = createAccount.isPending || updateAccount.isPending;

  function patch(change: Partial<ServiceAccountForm>) {
    setForm((prev) => ({ ...prev, ...change }));
  }

  // Preselect the default org once the list arrives (create only).
  useEffect(() => {
    if (editing || form.orgId || teamOrgs.length === 0) return;
    const preferred = teamOrgs.find((org) => org.default) ?? teamOrgs[0];
    if (preferred) setForm((prev) => ({ ...prev, orgId: preferred.id }));
  }, [editing, form.orgId, teamOrgs]);

  const selectedOrg = teamOrgs.find((org) => org.id === form.orgId);
  const ownerOfDefault = form.role === "owner" && selectedOrg?.default === true;
  const storedKind = account?.github.kind;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const error = validateForm(form, storedKind);
    setProblem(error);
    if (error) return;
    const onSuccess = () => onOpenChange(false);
    if (account) {
      updateAccount.mutate(updateBody(form), { onSuccess });
    } else {
      createAccount.mutate(createBody(form), { onSuccess });
    }
  }

  const choices: { value: GithubChoice; label: string }[] = [
    {
      value: "none",
      label:
        editing && storedKind !== "none"
          ? "Remove credential"
          : "No GitHub credential",
    },
    { value: "app", label: "GitHub App" },
    { value: "token", label: "Static token" },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${account.name}` : "Create service account"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? `Username ${account.username}.`
                : "Its username will be <name>[bot]."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {editing ? null : (
              <div className="space-y-1">
                <Label htmlFor="sa-name">Name</Label>
                <Input
                  id="sa-name"
                  value={form.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder="coding-agent"
                  pattern="[a-z0-9]([a-z0-9\-]{0,37}[a-z0-9])?"
                  title="Lowercase letters, digits and dashes, up to 39 characters"
                  required
                  autoFocus
                />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="sa-description">Description (optional)</Label>
              <Input
                id="sa-description"
                value={form.description}
                onChange={(e) => patch({ description: e.target.value })}
                maxLength={500}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="sa-org">Organization</Label>
                <NativeSelect
                  id="sa-org"
                  value={form.orgId}
                  onChange={(e) => patch({ orgId: e.target.value })}
                  required
                >
                  {form.orgId && !selectedOrg ? (
                    <option value={form.orgId}>
                      {account?.org?.name ?? form.orgId}
                    </option>
                  ) : null}
                  {teamOrgs.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.default ? `${org.name} (default)` : org.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="sa-role">Role</Label>
                <NativeSelect
                  id="sa-role"
                  value={form.role}
                  onChange={(e) =>
                    patch({ role: e.target.value as ServiceAccountRole })
                  }
                >
                  <option value="member">Member</option>
                  <option value="owner">Owner</option>
                </NativeSelect>
              </div>
            </div>
            {ownerOfDefault ? (
              <p className="text-xs text-warning">
                Owner of the default organization makes this account a server
                admin.
              </p>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="sa-github">GitHub credential</Label>
              <NativeSelect
                id="sa-github"
                value={
                  form.githubChoice === "remove" ? "none" : form.githubChoice
                }
                onChange={(e) => {
                  const value = e.target.value as GithubChoice;
                  patch({
                    githubChoice:
                      value === "none" && editing && storedKind !== "none"
                        ? "remove"
                        : value,
                  });
                }}
              >
                {choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {form.githubChoice === "app" ? (
              <AppFields
                form={form}
                patch={patch}
                keep={storedKind === "app"}
              />
            ) : null}
            {form.githubChoice === "token" ? (
              <TokenFields
                form={form}
                patch={patch}
                keep={storedKind === "token"}
              />
            ) : null}
            {problem ? (
              <p className="text-sm text-destructive">{problem}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : null}
              {editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AppFields({
  form,
  patch,
  keep,
}: {
  form: ServiceAccountForm;
  patch: (change: Partial<ServiceAccountForm>) => void;
  keep: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="sa-app-id">App ID</Label>
          <Input
            id="sa-app-id"
            value={form.appId}
            onChange={(e) => patch({ appId: e.target.value })}
            inputMode="numeric"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="sa-installation-id">Installation ID</Label>
          <Input
            id="sa-installation-id"
            value={form.installationId}
            onChange={(e) => patch({ installationId: e.target.value })}
            inputMode="numeric"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="sa-private-key">Private key (PEM)</Label>
        <Textarea
          id="sa-private-key"
          value={form.privateKey}
          onChange={(e) => patch({ privateKey: e.target.value })}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          className="p-2 font-mono text-xs"
          placeholder={
            keep
              ? "Leave empty to keep the stored key"
              : "-----BEGIN RSA PRIVATE KEY-----"
          }
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="sa-repositories">Repositories (optional)</Label>
        <Input
          id="sa-repositories"
          value={form.repositories}
          onChange={(e) => patch({ repositories: e.target.value })}
          placeholder="api, web"
        />
        <p className="text-xs text-muted-foreground">
          Bare repo names, comma or space separated. Empty means every
          repository of the installation.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="sa-permissions">Permissions (optional)</Label>
        <Input
          id="sa-permissions"
          value={form.permissions}
          onChange={(e) => patch({ permissions: e.target.value })}
          placeholder="contents:write, pull_requests:write"
        />
        <p className="text-xs text-muted-foreground">
          name:read or name:write. Empty means what the App was granted.
        </p>
      </div>
    </div>
  );
}

function TokenFields({
  form,
  patch,
  keep,
}: {
  form: ServiceAccountForm;
  patch: (change: Partial<ServiceAccountForm>) => void;
  keep: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="sa-token">Token</Label>
        <Input
          id="sa-token"
          type="password"
          value={form.token}
          onChange={(e) => patch({ token: e.target.value })}
          autoComplete="off"
          placeholder={keep ? "Leave empty to keep the stored token" : ""}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="sa-git-name">Git name</Label>
          <Input
            id="sa-git-name"
            value={form.gitName}
            onChange={(e) => patch({ gitName: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="sa-git-email">Git email</Label>
          <Input
            id="sa-git-email"
            type="email"
            value={form.gitEmail}
            onChange={(e) => patch({ gitEmail: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

function KeysSection({ id, accountId }: { id: string; accountId: string }) {
  const {
    data: keys,
    isPending,
    isError,
    error,
  } = useQuery(serviceAccountKeysQuery(accountId));
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div id={id} className="space-y-2 border-t pt-2">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
          <Plus />
          Create API key
        </Button>
      </div>
      {isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">No API keys yet.</p>
      ) : (
        <div className="space-y-2">
          {keys.map((key) => (
            <KeyRow key={key.id} accountId={accountId} apiKey={key} />
          ))}
        </div>
      )}
      <CreateKeyDialog
        accountId={accountId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}

function KeyRow({
  accountId,
  apiKey,
}: {
  accountId: string;
  apiKey: {
    id: string;
    name: string;
    keyPrefix: string;
    scope: "full" | "mcp";
    managedBy: "console" | "config";
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
  };
}) {
  const revoke = useRevokeServiceAccountKey(accountId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const fromConfig = apiKey.managedBy === "config";

  return (
    <div className="flex flex-col gap-2 rounded-md border p-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate font-medium">{apiKey.name}</span>
        <Badge variant="outline" className="font-mono">
          {apiKey.keyPrefix}…
        </Badge>
        <Badge variant={apiKey.scope === "mcp" ? "info" : "secondary"}>
          {apiKey.scope === "mcp" ? "MCP only" : "Full access"}
        </Badge>
        {fromConfig ? <Badge variant="outline">config</Badge> : null}
        <span className="text-xs text-muted-foreground">
          created {formatRelativeTime(apiKey.createdAt)}
        </span>
        {apiKey.lastUsedAt ? (
          <span className="text-xs text-muted-foreground">
            · used {formatRelativeTime(apiKey.lastUsedAt)}
          </span>
        ) : null}
        {apiKey.expiresAt ? (
          <span className="text-xs text-muted-foreground">
            · expires {formatRelativeTime(apiKey.expiresAt)}
          </span>
        ) : null}
      </div>
      {fromConfig ? null : (
        <Button
          variant="outline"
          size="icon"
          disabled={revoke.isPending}
          onClick={() => setConfirmOpen(true)}
          aria-label={`Revoke ${apiKey.name}`}
        >
          {revoke.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
        </Button>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Revoke API key?"
        description={
          <>
            Agents using <span className="font-mono">{apiKey.name}</span> will
            stop working. This cannot be undone.
          </>
        }
        confirmLabel="Revoke"
        onConfirm={() => revoke.mutateAsync(apiKey.id)}
      />
    </div>
  );
}

function CreateKeyDialog({
  accountId,
  open,
  onOpenChange,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createKey = useCreateServiceAccountKey(accountId);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [scope, setScope] = useState<"full" | "mcp">("mcp");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  function reset() {
    setName("");
    setExpiresAt("");
    setScope("mcp");
    setRawKey(null);
    createKey.reset();
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name) return;
    createKey.mutate(
      { name, expiresAt: expiresAt || undefined, scope },
      {
        onSuccess: (data) => {
          // Dismissed before the response arrived: don't resurrect the
          // dialog with the one-time key on the next open.
          if (data && openRef.current) setRawKey(data.rawKey);
        },
      },
    );
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        {rawKey ? (
          <>
            <DialogHeader>
              <DialogTitle>API key created</DialogTitle>
              <DialogDescription>
                Copy it now — it will not be shown again.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted p-2 font-mono text-xs">
                {rawKey}
              </code>
              <Button
                size="icon"
                variant="outline"
                onClick={() => {
                  navigator.clipboard
                    .writeText(rawKey)
                    .then(() => toast.success("Copied to clipboard"))
                    .catch(() => toast.error("Failed to copy to clipboard"));
                }}
                aria-label="Copy API key"
              >
                <Copy />
              </Button>
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-1">
                <Label htmlFor="sa-key-name">Name</Label>
                <Input
                  id="sa-key-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sa-key-expires">Expires (optional)</Label>
                <Input
                  id="sa-key-expires"
                  type="date"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sa-key-scope">Access</Label>
                <NativeSelect
                  id="sa-key-scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as "full" | "mcp")}
                >
                  <option value="mcp">MCP only</option>
                  <option value="full">Full access</option>
                </NativeSelect>
                <p className="text-xs text-muted-foreground">
                  MCP-only keys work on /mcp only, not on /mcp/admin or the HTTP
                  API.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createKey.isPending}>
                {createKey.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                Create
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
