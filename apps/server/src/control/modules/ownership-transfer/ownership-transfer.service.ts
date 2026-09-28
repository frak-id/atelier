/**
 * Move owner-scoped control records from one owner to an org: an org's
 * secrets + policy, and the toolboxes + Launchpad starters of an org or of
 * the caller's personal scope. A MOVE, not a copy: ids are kept, so pinned
 * toolbox versions, launched workspaces (`starterId`) and version history all
 * follow the record.
 *
 * Two phases share one planner: `preview` lists every movable item with the
 * reason it can't move (a name/slug clash in the target, an extra blocker the
 * caller supplies), and `execute` re-plans, validates the selection against
 * that plan and applies it atomically. Everything here is synchronous
 * (bun:sqlite), so plan → validate → write runs without interleaving.
 *
 * Authorization is the caller's job (`api/`): owner/admin on both sides.
 */
import type { CreateSandboxRequest, ToolboxOwner } from "@atelier/spec";
import { ConflictError, ValidationError } from "../../../shared/errors.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type {
  OwnershipTransferRepository,
  TransferToolboxRow,
} from "./ownership-transfer.repository.ts";

const log = createChildLogger("ownership-transfer");

const TRANSFER_KINDS = ["secrets", "policy", "toolboxes", "starters"] as const;
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
  /** Launchpad starters whose toolbox selectors were repointed. */
  rewrittenStarters: number;
}

export interface TransferOptions {
  /** Extra per-toolbox veto, checked against the pinned version's ref (e.g.
   * "a private capture can't be pinned org-wide" — a runtime fact control
   * can't see). Return a reason to block the move. */
  pinnedToolboxBlocker?: (activeVersionRef: string) => string | undefined;
}

interface Plan {
  preview: TransferPreview;
  toolboxes: Map<string, TransferToolboxRow>;
}

function selector(owner: ToolboxOwner, slug: string): string {
  return `tb/${owner.type}/${owner.id}/${slug}`;
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
      starters: this.repository.listStarters(owner).length,
    };
  }

  preview(
    from: ToolboxOwner,
    toOrgId: string,
    options: TransferOptions = {},
  ): TransferPreview {
    return this.plan(from, toOrgId, options).preview;
  }

  execute(
    from: ToolboxOwner,
    toOrgId: string,
    selection: TransferSelection,
    options: TransferOptions = {},
  ): TransferResult {
    const { preview, toolboxes } = this.plan(from, toOrgId, options);

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

    const toolboxIds = [...new Set(selection.toolboxes)];
    const target: ToolboxOwner = { type: "org", id: toOrgId };
    // Every starter (any owner) naming a moved toolbox by its old selector
    // would silently lose that toolbox at launch — repoint them.
    const renames = new Map<string, string>();
    for (const id of toolboxIds) {
      const slug = toolboxes.get(id)?.slug;
      if (slug) renames.set(selector(from, slug), selector(target, slug));
    }
    const recipeRewrites = this.rewriteStarterSelectors(renames);

    this.repository.apply({
      from,
      toOrgId,
      secretIds: [...new Set(selection.secrets)],
      policyIds: [...new Set(selection.policy)],
      toolboxIds,
      starterIds: [...new Set(selection.starters)],
      recipeRewrites,
    });

    const moved = Object.fromEntries(
      TRANSFER_KINDS.map((kind) => [kind, new Set(selection[kind]).size]),
    ) as Record<TransferKind, number>;
    log.info(
      {
        fromType: from.type,
        fromId: from.id,
        toOrgId,
        moved,
        rewrittenStarters: recipeRewrites.length,
      },
      "Ownership transfer applied",
    );
    return { moved, rewrittenStarters: recipeRewrites.length };
  }

  private plan(
    from: ToolboxOwner,
    toOrgId: string,
    options: TransferOptions,
  ): Plan {
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

    // Selector → number of starters (any owner) referencing it.
    const references = new Map<string, number>();
    for (const starter of this.repository.listStarters()) {
      for (const sel of new Set(starter.recipe.toolboxes ?? [])) {
        references.set(sel, (references.get(sel) ?? 0) + 1);
      }
    }

    const takenSlugs = new Set(
      this.repository.listToolboxes(target).map((t) => t.slug),
    );
    const rows = this.repository.listToolboxes(from);
    const toolboxes = rows.map((row): TransferItem => {
      const notes: string[] = [];
      if (row.activeVersionLabel !== null) {
        notes.push(`Stays pinned to v${row.activeVersionLabel}.`);
      } else {
        notes.push("Rebuilds once under the new owner on its next spawn.");
      }
      if (row.autoInject) {
        notes.push("Auto-injected into spawns that resolve to the target org.");
      }
      const refCount = references.get(selector(from, row.slug)) ?? 0;
      if (refCount > 0) {
        notes.push(
          `Referenced by ${refCount} Launchpad starter(s); they'll be updated.`,
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

    const starters = this.repository.listStarters(from).map(
      (starter): TransferItem => ({
        id: starter.id,
        label: starter.title,
        notes:
          from.type === "user" && starter.published
            ? ["Published: every member of the target org will see it."]
            : [],
      }),
    );

    return {
      preview: { secrets, policy, toolboxes, starters },
      toolboxes: new Map(rows.map((row) => [row.id, row])),
    };
  }

  private rewriteStarterSelectors(
    renames: Map<string, string>,
  ): { id: string; recipe: CreateSandboxRequest }[] {
    if (renames.size === 0) return [];
    const rewrites: { id: string; recipe: CreateSandboxRequest }[] = [];
    for (const starter of this.repository.listStarters()) {
      const selectors = starter.recipe.toolboxes;
      if (!selectors?.some((sel) => renames.has(sel))) continue;
      rewrites.push({
        id: starter.id,
        recipe: {
          ...starter.recipe,
          toolboxes: selectors.map((sel) => renames.get(sel) ?? sel),
        },
      });
    }
    return rewrites;
  }
}
