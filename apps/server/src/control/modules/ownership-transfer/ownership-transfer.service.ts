/**
 * Move an org's secrets and toolboxes into another org (a user's personal
 * scope is their personal org). A MOVE, not a copy: ids are kept, so pinned
 * toolbox versions and version history follow the record, and artifacts
 * (named after the toolbox id) never need renaming.
 *
 * Two phases share one planner: `preview` lists every movable item with the
 * reason it can't move (a name/slug clash in the target, an extra blocker the
 * caller supplies), and `execute` re-plans, validates the selection against
 * that plan and applies it atomically. Everything here is synchronous
 * (bun:sqlite), so plan → validate → write runs without interleaving.
 *
 * Authorization is the caller's job (`api/`).
 */
import { ConflictError, ValidationError } from "../../../shared/errors.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type { OwnershipTransferRepository } from "./ownership-transfer.repository.ts";

const log = createChildLogger("ownership-transfer");

const TRANSFER_KINDS = ["secrets", "toolboxes"] as const;
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

  /** How many records of each kind `orgId` still owns. Guards org deletion
   * against orphaning them. */
  inventory(orgId: string): Record<TransferKind, number> {
    return {
      secrets: this.repository.listSecrets(orgId).length,
      toolboxes: this.repository.listToolboxes(orgId).length,
    };
  }

  preview(
    fromOrgId: string,
    toOrgId: string,
    options: TransferOptions = {},
  ): TransferPreview {
    return this.plan(fromOrgId, toOrgId, options);
  }

  execute(
    fromOrgId: string,
    toOrgId: string,
    selection: TransferSelection,
    options: TransferOptions = {},
  ): TransferResult {
    const preview = this.plan(fromOrgId, toOrgId, options);

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
      fromOrgId,
      toOrgId,
      secretIds: [...new Set(selection.secrets)],
      toolboxIds: [...new Set(selection.toolboxes)],
    });

    const moved = Object.fromEntries(
      TRANSFER_KINDS.map((kind) => [kind, new Set(selection[kind]).size]),
    ) as Record<TransferKind, number>;
    log.info({ fromOrgId, toOrgId, moved }, "Ownership transfer applied");
    return { moved };
  }

  private plan(
    fromOrgId: string,
    toOrgId: string,
    options: TransferOptions,
  ): TransferPreview {
    if (fromOrgId === toOrgId) {
      throw new ValidationError("Source and target organization are the same");
    }

    const taken = new Set(
      this.repository.listSecrets(toOrgId).map((s) => s.name),
    );
    const secrets = this.repository.listSecrets(fromOrgId).map(
      (secret): TransferItem => ({
        id: secret.id,
        label: secret.name,
        notes: [],
        ...(taken.has(secret.name)
          ? { blocker: "a secret with this name already exists in the target" }
          : {}),
      }),
    );

    const takenSlugs = new Set(
      this.repository.listToolboxes(toOrgId).map((t) => t.slug),
    );
    const toolboxes = this.repository
      .listToolboxes(fromOrgId)
      .map((row): TransferItem => {
        const notes: string[] = [];
        if (row.activeVersionLabel !== null) {
          notes.push(`Stays pinned to v${row.activeVersionLabel}.`);
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

    return { secrets, toolboxes };
  }
}
