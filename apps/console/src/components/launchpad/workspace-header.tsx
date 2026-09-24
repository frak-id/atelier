import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Moon, RotateCw, Sunrise, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  useDeleteWorkspace,
  useUpdateWorkspace,
  useWorkspaceAction,
  type WorkspaceDetail,
} from "@/api/queries/launchpad";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineEdit } from "@/components/launchpad/inline-edit";
import { PhaseBadge } from "@/components/launchpad/phase-badge";
import { Button } from "@/components/ui/button";
import { LaunchpadIconView, PHASE_PRESENTATION } from "@/lib/launchpad";

/**
 * The workspace page header: the user's own name and note (edited in place —
 * the only place they're edited), the plain-English status and the actions
 * the current phase allows.
 */
export function WorkspaceHeader({
  workspace,
  editName,
}: {
  workspace: WorkspaceDetail;
  /** Open the name field right away (just launched, or "rename" from a
   * card). */
  editName: boolean;
}) {
  const update = useUpdateWorkspace();
  const save = (patch: { title?: string; description?: string }) =>
    update.mutate({ id: workspace.id, patch });

  return (
    <div className="border-b px-4 py-4">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Button
            variant="ghost"
            size="icon"
            asChild
            className="mt-0.5 shrink-0"
          >
            <Link to="/launchpad" aria-label="Back to the Launchpad">
              <ArrowLeft />
            </Link>
          </Button>
          <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <LaunchpadIconView icon={workspace.icon} />
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="min-w-0 max-w-full">
                <InlineEdit
                  label="Workspace name"
                  value={workspace.title}
                  onSave={(title) => save({ title })}
                  placeholder="Name this workspace"
                  required
                  maxLength={120}
                  autoEdit={editName}
                  className="w-auto text-xl font-semibold"
                  inputClassName="text-xl font-semibold"
                />
              </div>
              <PhaseBadge phase={workspace.phase} />
            </div>
            <InlineEdit
              label="Note"
              value={workspace.description}
              onSave={(description) => save({ description })}
              placeholder="Add a note: what is this for?"
              multiline
              maxLength={1000}
              className="text-sm text-muted-foreground"
              inputClassName="text-sm"
            />
            <p className="px-0 text-xs text-muted-foreground">
              Started from {workspace.starterTitle}
            </p>
          </div>
        </div>
        <WorkspaceActions workspace={workspace} />
      </div>
    </div>
  );
}

function WorkspaceActions({ workspace }: { workspace: WorkspaceDetail }) {
  const navigate = useNavigate();
  const action = useWorkspaceAction();
  const remove = useDeleteWorkspace();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const busy = PHASE_PRESENTATION[workspace.phase].busy;
  const pending = (name: "sleep" | "wake" | "retry") =>
    action.isPending && action.variables?.action === name;

  return (
    <div className="flex shrink-0 items-center gap-2 lg:pt-1">
      {workspace.phase === "ready" ? (
        <Button
          variant="outline"
          size="sm"
          loading={pending("sleep")}
          disabled={action.isPending}
          onClick={() => action.mutate({ id: workspace.id, action: "sleep" })}
          title="Frees up resources. Your work is kept."
        >
          <Moon />
          Put to sleep
        </Button>
      ) : null}
      {workspace.phase === "sleeping" ? (
        <Button
          size="sm"
          loading={pending("wake")}
          disabled={action.isPending}
          onClick={() => action.mutate({ id: workspace.id, action: "wake" })}
        >
          <Sunrise />
          Wake up
        </Button>
      ) : null}
      {workspace.phase === "failed" ? (
        <Button
          size="sm"
          loading={pending("retry")}
          disabled={action.isPending}
          onClick={() => action.mutate({ id: workspace.id, action: "retry" })}
        >
          <RotateCw />
          Try again
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        disabled={busy}
        onClick={() => setConfirmOpen(true)}
        aria-label="Delete workspace"
        title={
          busy ? "Wait until it has finished starting" : "Delete workspace"
        }
        className="text-muted-foreground hover:text-danger"
      >
        <Trash2 />
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete this workspace?"
        description={
          <>
            <strong>{workspace.title}</strong> and everything in it will be
            permanently deleted. This can't be undone.
          </>
        }
        onConfirm={() =>
          remove.mutate(workspace.id, {
            onSuccess: () => navigate({ to: "/launchpad" }),
          })
        }
      />
    </div>
  );
}
