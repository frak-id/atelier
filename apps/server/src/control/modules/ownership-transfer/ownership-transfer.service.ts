/**
 * Move owner-scoped control records from one owner to an org: an org's
 * secrets + policy, and the toolboxes of an org or of the caller's personal
 * scope. A MOVE, not a copy: ids are kept, so pinned toolbox versions and
 * version history follow the record.
 *
 * Two phases share one planner: `preview` lists every movable item with the
 * reason it can't move (a name/slug clash in the target, an extra blocker the
 * caller supplies), and `execute` re-plans, validates the selection against
 * that plan and applies it atomically. Everything here is synchronous
 * (bun:sqlite), so plan → validate → write runs without interleaving.
 *
 * Authorization is the caller's job (`api/`): owner/admin on both sides.
 */
import type { ToolboxOwner } from "@atelier/spec";
import { ConflictError, ValidationError } from "../../../shared/errors.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type { OwnershipTransferRepository } from "./ownership-transfer.repository.ts";

const log = createChildLogger("ownership-transfer");

const TRANSFER_KINDS = ["secrets", "policy", "toolboxes"] as const;
type TransferKind = (typeof TRANSFER_KINDS)[number];

interface TransferItem {
  id: string;
  label: string;
  /** Why this item can't move (it's then not selectable). */
  blocker?: string;
  /** Side effects worth knowing before moving it. */
  notes: string[];
}

export type TransferPreview = Record<TransferKind, TransferItem[]>;
export type TransferSelection = Record<TransferKind, string[]>;

export interface TransferResult {
  moved: Record<TransferKind, number>;
}

export interface TransferOptions {
  /** Extra per-toolbox veto, checked against the pinned version's ref (e.g.
   * "a private capture can't be pinned org-wide" — a runtime fact control
   * can't see). Return a reason to block the move. */
  pinnedToolboxBlocker?: (activeVersionRef: string) => string | undefined;
}

export class OwnershipTransferService {
  constructor(private readonly repository: OwnershipTransferRepository) {}

  /** How many records of each kind `owner` still owns (secrets + policy
   * only exist for orgs). Guards org deletion against orphaning them. */
  inventory(owner: ToolboxOwner): Record<TransferKind, number> {
    const isOrg = owner.type === "org";
    return {
      secrets: isOrg ? this.repository.listSecrets(owner.id).length : 0,
      policy: isOrg && this.repository.getPolicyId(owner.id) ? 1 : 0,
      toolboxes: this.repository.listToolboxes(owner).length,
    };
  }

  preview(
    from: ToolboxOwner,
    toOrgId: string,
    options: TransferOptions = {},
  ): TransferPreview {
    return this.plan(from, toOrgId, options);
  }

  execute(
    from: ToolboxOwner,
    toOrgId: string,
    selection: TransferSelection,
    options: TransferOptions = {},
  ): TransferResult {
    const preview = this.plan(from, toOrgId, options);

    let total = 0;
    for (const kind of TRANSFER_KINDS) {
      const items = new Map(preview[kind].map((item) => [item.id, item]));
      for (const id of new Set(selection[kind])) {
        const item = items.get(id);
        if (!item) {
          throw new ValidationError(
            `${kind} '${id}' does not belong to the source owner`,
          );
        }
        if (item.blocker) {
          throw new ConflictError(
            `Cannot move '${item.label}': ${item.blocker}`,
          );
        }
        total++;
      }
    }
    if (total === 0) throw new ValidationError("Nothing selected to move");

    this.repository.apply({
      from,
      toOrgId,
      secretIds: [...new Set(selection.secrets)],
      policyIds: [...new Set(selection.policy)],
      toolboxIds: [...new Set(selection.toolboxes)],
    });

    const moved = Object.fromEntries(
      TRANSFER_KINDS.map((kind) => [kind, new Set(selection[kind]).size]),
    ) as Record<TransferKind, number>;
    log.info(
      { fromType: from.type, fromId: from.id, toOrgId, moved },
      "Ownership transfer applied",
    );
    return { moved };
  }

  private plan(
    from: ToolboxOwner,
    toOrgId: string,
    options: TransferOptions,
  ): TransferPreview {
    if (from.type === "org" && from.id === toOrgId) {
      throw new ValidationError("Source and target organization are the same");
    }
    const target: ToolboxOwner = { type: "org", id: toOrgId };

    // Secrets + policy are org-only concepts: a personal scope has neither.
    const secrets: TransferItem[] = [];
    const policy: TransferItem[] = [];
    if (from.type === "org") {
      const taken = new Set(
        this.repository.listSecrets(toOrgId).map((s) => s.name),
      );
      for (const secret of this.repository.listSecrets(from.id)) {
        secrets.push({
          id: secret.id,
          label: secret.name,
          notes: [],
          ...(taken.has(secret.name)
            ? {
                blocker: "a secret with this name already exists in the target",
              }
            : {}),
        });
      }
      const policyId = this.repository.getPolicyId(from.id);
      if (policyId) {
        policy.push({
          id: policyId,
          label: "Org policy",
          notes: [],
          ...(this.repository.getPolicyId(toOrgId)
            ? { blocker: "the target organization already has a policy" }
            : {}),
        });
      }
    }

    const takenSlugs = new Set(
      this.repository.listToolboxes(target).map((t) => t.slug),
    );
    const toolboxes = this.repository
      .listToolboxes(from)
      .map((row): TransferItem => {
        const notes: string[] = [];
        if (row.activeVersionLabel !== null) {
          notes.push(`Stays pinned to v${row.activeVersionLabel}.`);
        } else {
          notes.push("Rebuilds once under the new owner on its next spawn.");
        }
        if (row.autoInject) {
          notes.push(
            "Auto-injected into spawns that resolve to the target org.",
          );
        }
        const blocker = takenSlugs.has(row.slug)
          ? "a toolbox with this slug already exists in the target"
          : row.activeVersionRef
            ? options.pinnedToolboxBlocker?.(row.activeVersionRef)
            : undefined;
        return {
          id: row.id,
          label: row.slug,
          notes,
          ...(blocker ? { blocker } : {}),
        };
      });

    return { secrets, policy, toolboxes };
  }
}
