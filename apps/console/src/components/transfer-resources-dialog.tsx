import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { OrgMemberRole } from "@/api/queries/organizations";
import {
  TRANSFER_KINDS,
  type TransferItem,
  type TransferKind,
  type TransferSelection,
  transferPreviewQuery,
  useMoveResources,
} from "@/api/queries/transfers";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";

type Org = {
  id: string;
  name: string;
  slug: string;
  personal: boolean;
  role: OrgMemberRole;
};

const SECTION_TITLE: Record<TransferKind, string> = {
  secrets: "Secrets",
  policy: "Org policy",
  toolboxes: "Toolboxes",
  starters: "Launchpad starters",
};

function canManage(role: OrgMemberRole): boolean {
  return role === "owner" || role === "admin";
}

function emptySelection(): TransferSelection {
  return { secrets: [], policy: [], toolboxes: [], starters: [] };
}

/**
 * "Move resources": moves (not copies) an org's or the caller's personal
 * secrets/policy/toolboxes/Launchpad starters into another org. Reachable
 * from the Organizations page's header.
 */
export function TransferResourcesDialog({
  open,
  onOpenChange,
  organizations,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizations: Org[];
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selection, setSelection] = useState<TransferSelection>(
    emptySelection(),
  );

  const manageableOrgs = useMemo(
    () => organizations.filter((org) => canManage(org.role)),
    [organizations],
  );
  const fromOrgId = from.startsWith("org:") ? from.slice(4) : undefined;
  const toOrgs = manageableOrgs.filter((org) => org.id !== fromOrgId);

  function resetSelectionFor(nextFrom: string, nextTo: string) {
    setSelection(emptySelection());
    setFrom(nextFrom);
    setTo(nextTo);
  }

  const {
    data: preview,
    isPending: previewPending,
    isError: previewError,
  } = useQuery(transferPreviewQuery(from, to));

  // Nothing is pre-selected: moving secrets across orgs is not reversible
  // from here, so every item is an explicit opt-in.

  const moveResources = useMoveResources();

  function reset() {
    setFrom("");
    setTo("");
    setSelection(emptySelection());
  }

  const totalSelected = TRANSFER_KINDS.reduce(
    (sum, kind) => sum + selection[kind].length,
    0,
  );

  function toggleItem(kind: TransferKind, id: string) {
    setSelection((prev) => {
      const has = prev[kind].includes(id);
      return {
        ...prev,
        [kind]: has ? prev[kind].filter((x) => x !== id) : [...prev[kind], id],
      };
    });
  }

  function setAll(kind: TransferKind, items: TransferItem[], checked: boolean) {
    const ids = items.filter((item) => !item.blocker).map((item) => item.id);
    setSelection((prev) => ({ ...prev, [kind]: checked ? ids : [] }));
  }

  function handleMove() {
    if (!from || !to || totalSelected === 0) return;
    moveResources.mutate(
      { from, to, selection },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
        },
      },
    );
  }

  const hasAnyItems = preview
    ? TRANSFER_KINDS.some((kind) => preview[kind].length > 0)
    : false;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Move resources</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="transfer-from">From</Label>
              <NativeSelect
                id="transfer-from"
                value={from}
                onChange={(e) => resetSelectionFor(e.target.value, to)}
              >
                <option value="" disabled>
                  Select a source…
                </option>
                <option value="user">My personal resources</option>
                {manageableOrgs.map((org) => (
                  <option key={org.id} value={`org:${org.id}`}>
                    {org.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="transfer-to">To</Label>
              <NativeSelect
                id="transfer-to"
                value={to}
                onChange={(e) => resetSelectionFor(from, e.target.value)}
              >
                <option value="" disabled>
                  Select a destination…
                </option>
                {toOrgs.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          {from && to ? (
            <>
              <p className="text-xs text-muted-foreground">
                This moves the selected items, it doesn't copy them: they leave
                the source and belong to the destination organization, visible
                to its members only.
              </p>
              {previewPending ? (
                <Skeleton className="h-24 w-full" />
              ) : previewError ? (
                <p className="text-sm text-destructive">
                  Failed to load the preview.
                </p>
              ) : !hasAnyItems ? (
                <p className="text-sm text-muted-foreground">
                  Nothing to move.
                </p>
              ) : (
                <div className="max-h-80 space-y-4 overflow-y-auto">
                  {TRANSFER_KINDS.map((kind) => {
                    const items = preview?.[kind] ?? [];
                    if (items.length === 0) return null;
                    return (
                      <TransferSection
                        key={kind}
                        title={SECTION_TITLE[kind]}
                        items={items}
                        selected={selection[kind]}
                        onToggle={(id) => toggleItem(kind, id)}
                        onSetAll={(checked) => setAll(kind, items, checked)}
                      />
                    );
                  })}
                </div>
              )}
            </>
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
          <Button
            type="button"
            disabled={
              !from || !to || totalSelected === 0 || moveResources.isPending
            }
            onClick={handleMove}
          >
            {moveResources.isPending ? (
              <Loader2 className="animate-spin" />
            ) : null}
            Move {totalSelected} item{totalSelected === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransferSection({
  title,
  items,
  selected,
  onToggle,
  onSetAll,
}: {
  title: string;
  items: TransferItem[];
  selected: string[];
  onToggle: (id: string) => void;
  onSetAll: (checked: boolean) => void;
}) {
  const selectable = items.filter((item) => !item.blocker);
  const allSelected =
    selectable.length > 0 && selectable.every((i) => selected.includes(i.id));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{title}</span>
        {selectable.length > 0 ? (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => onSetAll(!allSelected)}
          >
            {allSelected ? "Select none" : "Select all"}
          </button>
        ) : null}
      </div>
      <div className="space-y-1.5">
        {items.map((item) => (
          <div key={item.id} className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={selected.includes(item.id)}
              disabled={!!item.blocker}
              onChange={() => onToggle(item.id)}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate">{item.label}</div>
              {item.blocker ? (
                <p className="text-xs text-destructive">{item.blocker}</p>
              ) : null}
              {item.notes.map((note) => (
                <p key={note} className="text-xs text-muted-foreground">
                  {note}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
