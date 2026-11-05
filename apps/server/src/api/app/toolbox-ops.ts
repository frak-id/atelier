/**
 * Toolbox operations — the one application layer under `/api/toolboxes`, the
 * spawn pipeline and the MCP `manage_toolbox` tool. It is where control
 * (toolboxes, versions, pin), the runtime (artifacts) and the jobs feed meet:
 * resolving a spawn's toolboxes, recording and pruning versions, capturing,
 * pinning (publish before pin), publishing, deleting a version. Callers are
 * thin: they authenticate, parse, and call a method here.
 */

import {
  type PortEntry,
  type ProcessEntry,
  type RuntimeSurface,
  type SandboxSpec,
  type ToolboxConfig,
  type ToolboxConfigInput,
  type ToolboxConfigPatch,
  type ToolboxVersion,
  type ToolsetRef,
  toolboxArtifactName,
} from "@atelier/spec";
import {
  type ControlContainer,
  recipeFingerprint,
} from "../../control/index.ts";
import { mergeSpecs } from "../../harnesses/spec-merge.ts";
import type {
  JobRecord,
  JobService,
  RuntimeService,
} from "../../runtime/index.ts";
import { ValidationError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { requireSandboxAccess, requireSourceAccess } from "../sandbox-guard.ts";
import { requireToolboxAccess, resolveToolboxOrg } from "../toolbox-access.ts";

const log = createChildLogger("toolbox-ops");

/** Soft cap on auto-inject toolboxes per org — a boot-latency tradeoff, not a
 * hard limit. */
const TOOLBOX_SOFT_CAP = 5;

export interface ToolboxOpsDeps {
  runtime: RuntimeService;
  control: ControlContainer;
  jobs: JobService;
}

/** What a spawn applies from its toolboxes. */
export interface SpawnToolboxes {
  /** Built or pinned toolsets to materialize (toolboxes with `paths`). */
  refs: ToolsetRef[];
  /** Every toolbox applied, in precedence order (later wins): the org's
   * auto-inject ones oldest-first, the picked selectors, then the toolboxes
   * behind explicit `spec.toolsets` refs. Drives harness, files and surface. */
  applied: ToolboxConfig[];
}

/** The toolbox id in a toolbox artifact ref or selector (`tb/<id>`, with or
 * without a registry prefix or `@digest`). Artifacts built before artifact
 * names were keyed on the id (`tb/<ownerType>/<ownerId>/<slug>`) don't match:
 * their version rows keep resolving through the stored `ref`, they just can't
 * be mapped back to a toolbox from the name alone. */
function toolboxIdOfRef(ref: string): string | undefined {
  return ref.match(/(?:^|\/)tb\/([^/@]+)(?:@|$)/)?.[1];
}

/** The winning harness a spawn's toolboxes declare: the
 * last applied toolbox that names one. Undefined when none does. */
export function toolboxHarness(applied: ToolboxConfig[]): string | undefined {
  return [...applied].reverse().find((config) => config.harness)?.harness;
}

/**
 * The spec with the applied toolboxes' files merged in (keyed by path: a later
 * toolbox wins, and the spec's own file wins over every toolbox). Runs BEFORE
 * enrichment, so a toolbox file's `$secret` ref is stored as a ref and
 * resolved at every boot.
 */
export function withToolboxFiles(
  spec: SandboxSpec,
  applied: ToolboxConfig[],
): SandboxSpec {
  const files = mergeSpecs(
    ...applied.map((config) => ({ files: config.files })),
    { files: spec.files },
  ).files;
  return files ? { ...spec, files } : spec;
}

/**
 * Collect the processes + ports every applied toolbox contributes
 *. A toolbox is not just files: it can carry a tool's
 * *runtime surface* — vscode's `code-server` process + its port, or the
 * browser stack's kasmvnc/openbox/chromium (binaries baked into the
 * dev-browser base image, so no `build`/`paths`; a browserless base like
 * dev-base won't have them). Returns a spec fragment the caller merges in.
 */
export function toolboxSurface(
  applied: ToolboxConfig[],
): Required<RuntimeSurface> {
  const processes: ProcessEntry[] = [];
  const ports: PortEntry[] = [];
  for (const config of applied) {
    if (config.processes) processes.push(...config.processes);
    if (config.ports) ports.push(...config.ports);
  }
  return { processes, ports };
}

/** Ids to move per kind, as the transfer service takes them. */
type TransferSelection = Parameters<
  ControlContainer["ownershipTransferService"]["execute"]
>[2];

export class ToolboxOps {
  private readonly runtime: RuntimeService;
  private readonly control: ControlContainer;
  private readonly jobs: JobService;

  constructor(deps: ToolboxOpsDeps) {
    this.runtime = deps.runtime;
    this.control = deps.control;
    this.jobs = deps.jobs;
  }

  /** The slice of the container the sandbox access guards read. */
  private get guard() {
    return { runtime: this.runtime, control: this.control };
  }

  /** The toolbox behind a `tb/<id>` selector, artifact ref or registry name. */
  forRef(ref: string): ToolboxConfig | undefined {
    const id = toolboxIdOfRef(ref);
    return id ? this.control.toolboxService.find(id) : undefined;
  }

  /**
   * The harness the toolbox behind a single toolset name declares, if any.
   * Caller-independent. Used to enrich the global toolset list so the console
   * can tag any toolset with its harness.
   */
  harnessForToolset(name: string): string | undefined {
    return this.forRef(name)?.harness;
  }

  // ── spawn ──────────────────────────────────────────────────────────────

  /**
   * Resolve the toolboxes a spawn applies: the spawn
   * org's auto-inject toolboxes, then the explicitly picked `tb/<id>`
   * selectors. `orgId` is optional (`undefined` skips the org tier — spawn
   * bare, never throw); a selected toolbox must belong to an org the caller is
   * in. A toolbox without `paths` (process-only, files-only) produces no
   * toolset but is still applied. A single toolbox's build failure is logged
   * and skipped, never fails the spawn.
   */
  async resolveForSpawn(input: {
    orgId?: string;
    userId: string;
    selectors: string[];
    toolsets: ToolsetRef[];
  }): Promise<SpawnToolboxes> {
    const { toolboxService, orgMemberService } = this.control;
    const autoInject = input.orgId
      ? toolboxService.listAutoInject(input.orgId)
      : [];
    const selected = input.selectors.flatMap((selector) => {
      const config = this.forRef(selector);
      if (!config) return [];
      orgMemberService.requireMembership(config.orgId, input.userId);
      return [config];
    });
    // The caller's explicit toolsets are already materialized by the spec;
    // they only contribute their toolbox's harness/files/surface, and only
    // when the caller belongs to that toolbox's org.
    const explicit = input.toolsets.flatMap(({ ref }) => {
      const config = this.forRef(ref);
      const member =
        config && orgMemberService.getMembership(config.orgId, input.userId);
      return config && member ? [config] : [];
    });

    const applied = [
      ...new Map(
        [...autoInject, ...selected, ...explicit].map((c) => [c.id, c]),
      ).values(),
    ];
    // Resolve everything concurrently — builds are content-hash idempotent
    // and inflight-deduped, so parallel cold builds each get their own
    // throwaway pod instead of queuing. `Promise.all` preserves position.
    const refs = await Promise.all(
      [...autoInject, ...selected]
        .filter((config) => config.paths.length > 0)
        .map((config) => this.resolveToRef(config)),
    );
    return { refs: refs.filter((ref) => ref !== undefined), applied };
  }

  /**
   * Resolve one toolbox to a `ToolsetRef`, or `undefined` if it can't be
   * resolved this spawn: the pinned fast path (docs/toolbox-versions.md §2:
   * straight to the saved ref, no build; a dangling pin falls back to the
   * recipe build), else build + lazy-record, else log-and-skip.
   *
   * Each build uses a STABLE registry name keyed on the immutable toolbox id
   * (`toolboxArtifactName`), so renaming an org or moving the toolbox to
   * another org never churns artifacts. `buildToolset` is content-hash
   * idempotent + inflight-deduped, so resolving fresh on every spawn is cheap
   * after the first build.
   */
  private async resolveToRef(
    config: ToolboxConfig,
  ): Promise<ToolsetRef | undefined> {
    const activeId = this.control.toolboxService.getActiveVersionId(config.id);
    if (activeId) {
      const version = this.control.toolboxVersionService.find(activeId);
      if (version) return { ref: version.ref };
      log.warn(
        { slug: config.slug, activeId },
        "pinned toolbox version missing; falling back to recipe build",
      );
    }
    try {
      const { ref } = await this.runtime.buildToolset({
        name: toolboxArtifactName(config),
        source: config.source,
        build: config.build,
        paths: config.paths,
      });
      await this.recordBuiltVersionLazily(config, ref);
      return { ref };
    } catch (err) {
      log.error(
        { err, orgId: config.orgId, slug: config.slug },
        "toolbox build failed; skipping for this spawn",
      );
      return undefined;
    }
  }

  /**
   * Lazily record a recipe-built artifact as a `built` version row, once per
   * distinct ref (docs/toolbox-versions.md §3) — so version history stays
   * complete even for toolboxes that never went through an explicit capture.
   * Gated on `existsByRef` first so the hot spawn path stays a single indexed
   * lookup once a ref has been recorded. Recording a version row must never
   * fail a spawn: every failure is caught and logged only.
   */
  async recordBuiltVersionLazily(
    config: ToolboxConfig,
    ref: string,
  ): Promise<void> {
    try {
      if (this.control.toolboxVersionService.existsByRef(config.id, ref)) {
        return;
      }
      const sourceImage = await this.runtime
        .resolveSourceImage(
          config.source ?? { image: this.runtime.defaultImage() },
        )
        .catch(() => undefined);
      this.control.toolboxVersionService.recordBuilt(config.id, {
        ref,
        recipeFingerprint: recipeFingerprint(config),
        sourceImage,
      });
      this.pruneVersions(config.id);
    } catch (err) {
      log.error(
        { err, toolboxId: config.id, ref },
        "lazy built-version recording failed; spawn continues",
      );
    }
  }

  /**
   * Enforce the per-toolbox retention policy after a new version row is added
   * (docs/toolbox-versions.md §6) — called after lazy `built` recording,
   * explicit capture and refresh. Also drops the runtime toolset record for
   * any pruned version (Zot retention handles the underlying blobs). Log-only:
   * pruning must never fail the caller's request. `deleteToolset` refuses a
   * ref still mounted by a live/paused sandbox: the swallowing catch is right
   * for that, the record just outlives the version row.
   */
  pruneVersions(toolboxId: string): void {
    try {
      const deleted = this.control.toolboxVersionService.pruneOldVersions(
        toolboxId,
        this.control.toolboxService.getActiveVersionId(toolboxId),
      );
      for (const v of deleted) {
        try {
          this.runtime.deleteToolset(v.ref);
        } catch {}
      }
    } catch (err) {
      log.error({ err, toolboxId }, "toolbox version retention prune failed");
    }
  }

  // ── authoring ──────────────────────────────────────────────────────────

  /** A toolbox the caller may reach (a member of its org), or a 404/403. */
  authorize(userId: string, id: string): ToolboxConfig {
    const toolbox = this.control.toolboxService.get(id);
    requireToolboxAccess(this.control, toolbox, userId);
    return toolbox;
  }

  /** Create a toolbox in the scope `owner` names (default: the caller's
   * personal org). */
  create(
    userId: string,
    owner: string | undefined,
    input: ToolboxConfigInput,
  ): ToolboxConfig {
    const orgId = resolveToolboxOrg(this.control, userId, owner);
    // The source is built over at every spawn: check it now, as the writer.
    requireSourceAccess(this.guard, userId, input.source);
    const created = this.control.toolboxService.create(orgId, input);
    const autoInjectCount =
      this.control.toolboxService.listAutoInject(orgId).length;
    if (autoInjectCount > TOOLBOX_SOFT_CAP) {
      log.warn(
        { orgId, autoInjectCount },
        `org exceeds the soft cap of ${TOOLBOX_SOFT_CAP} auto-inject toolboxes — each adds boot latency to every spawn`,
      );
    }
    return created;
  }

  update(userId: string, id: string, patch: ToolboxConfigPatch): ToolboxConfig {
    this.authorize(userId, id);
    requireSourceAccess(this.guard, userId, patch.source);
    return this.control.toolboxService.update(id, patch);
  }

  delete(userId: string, id: string): void {
    this.authorize(userId, id);
    this.control.toolboxService.delete(id);
  }

  // ── versions ───────────────────────────────────────────────────────────

  /** A version of THIS toolbox, or a `ValidationError`. */
  private versionOf(toolbox: ToolboxConfig, versionId: string): ToolboxVersion {
    const version = this.control.toolboxVersionService.get(versionId);
    if (version.toolboxId !== toolbox.id) {
      throw new ValidationError("version does not belong to this toolbox");
    }
    return version;
  }

  /**
   * Capture a sandbox's toolbox paths as a new version, as a pooled job in
   * the feed: agent tar + secret scan + push, drift probe, version row,
   * retention prune. Authorization and validation are synchronous (the caller
   * gets a 4xx, not a failed job); the version is the job's result.
   */
  startCapture(
    userId: string,
    id: string,
    input: { sandboxId: string; description: string },
  ): JobRecord {
    const run = this.prepareCapture(userId, id, input);
    return this.jobs.dispatch(run.options, run.fn);
  }

  /** `startCapture`, awaited: resolves to the saved version. */
  captureAndWait(
    userId: string,
    id: string,
    input: { sandboxId: string; description: string },
  ): Promise<ToolboxVersion> {
    const run = this.prepareCapture(userId, id, input);
    return this.jobs.dispatchAndWait(run.options, run.fn);
  }

  private prepareCapture(
    userId: string,
    id: string,
    input: { sandboxId: string; description: string },
  ) {
    const toolbox = this.authorize(userId, id);
    // The sandbox arrives in the body, not a guarded `:id` path.
    requireSandboxAccess(this.guard, userId, input.sandboxId);
    if (toolbox.paths.length === 0) {
      throw new ValidationError("toolbox has no paths to capture");
    }
    return {
      options: {
        kind: "toolset-capture" as const,
        target: toolbox.slug,
        metadata: { toolboxId: toolbox.id, sandboxId: input.sandboxId },
      },
      fn: async (
        signal: AbortSignal,
        onLog: (chunk: string) => void,
      ): Promise<ToolboxVersion> => {
        // Server-authoritative capture inputs (docs/toolbox-versions.md §2
        // invariant): a "version" must capture the toolbox's OWN paths[] to
        // stay substitutable for the recipe-built artifact, never whatever
        // the caller passes.
        const { ref } = await this.runtime.captureToolset(
          input.sandboxId,
          {
            name: toolboxArtifactName(toolbox),
            paths: toolbox.paths,
            exclude: [],
            overrides: [],
          },
          signal,
          onLog,
        );
        // Best-effort drift signal (docs/toolbox-versions.md §5): the base
        // image the sandbox was actually running at capture time.
        const sourceImage = await this.runtime
          .getSandboxImage(input.sandboxId)
          .catch(() => undefined);
        // Save, don't pin — pinning is a separate, explicit call (§7).
        const version = this.control.toolboxVersionService.create(toolbox.id, {
          ref,
          description: input.description,
          provenance: {
            kind: "captured",
            capturedFrom: input.sandboxId,
            capturedBy: userId,
            ...(sourceImage ? { sourceImage } : {}),
          },
          recipeFingerprint: recipeFingerprint(toolbox),
        });
        this.pruneVersions(toolbox.id);
        return version;
      },
    };
  }

  /**
   * Pin a version org-wide (`null` unpins). Publish-before-pin guard
   * (docs/toolbox-versions.md §5): a private capture pinned org-wide would
   * replay one user's config (and possibly secrets) into every future spawn
   * of the whole org.
   */
  pin(userId: string, id: string, versionId: string | null): string | null {
    const toolbox = this.authorize(userId, id);
    if (versionId === null) {
      this.control.toolboxService.setActiveVersionId(toolbox.id, null);
      return null;
    }
    const version = this.versionOf(toolbox, versionId);
    if (this.runtime.getToolsetEntry(version.ref)?.private === true) {
      throw new ValidationError(
        "publish this version before pinning a toolbox org-wide",
      );
    }
    this.control.toolboxService.setActiveVersionId(toolbox.id, version.id);
    return version.id;
  }

  /** Mark a version's artifact as shareable (flip `private` off). Same
   * bytes, same digest: publishing never changes what a pin replays. */
  publish(
    userId: string,
    id: string,
    versionId: string,
  ): { versionId: string; private: boolean } {
    const toolbox = this.authorize(userId, id);
    const version = this.versionOf(toolbox, versionId);
    const entry = this.runtime.publishToolset(version.ref);
    log.info(
      { toolboxId: toolbox.id, versionId: version.id, ref: version.ref },
      "toolbox version published",
    );
    return { versionId: version.id, private: entry.private === true };
  }

  /** Delete one version of the toolbox; never the pinned one. */
  deleteVersion(userId: string, id: string, versionId: string): void {
    const toolbox = this.authorize(userId, id);
    const version = this.versionOf(toolbox, versionId);
    if (
      this.control.toolboxService.getActiveVersionId(toolbox.id) === version.id
    ) {
      throw new ValidationError(
        "cannot delete the active version; unpin it first",
      );
    }
    this.control.toolboxVersionService.delete(toolbox.id, version.id);
  }

  // ── ownership transfer ─────────────────────────────────────────────────

  /**
   * AuthZ for an ownership transfer: an owner of the source org (their
   * personal org, typically) and a member of the target: sharing a toolbox
   * with the team is open to every member. Moving secrets writes them into
   * the target, which takes an owner there. A non-member gets 403 for an org
   * that doesn't exist, too.
   */
  private authorizeTransfer(
    userId: string,
    from: string,
    to: string,
    movesSecrets: boolean,
  ): void {
    const { orgMemberService } = this.control;
    orgMemberService.requireOwner(from, userId);
    if (movesSecrets) orgMemberService.requireOwner(to, userId);
    else orgMemberService.requireMembership(to, userId);
  }

  /** The same invariant as the publish-before-pin guard: a private capture
   * pinned org-wide would replay one user's config (maybe secrets) into
   * every org spawn. */
  private get transferOptions() {
    return {
      pinnedToolboxBlocker: (ref: string) =>
        this.runtime.getToolsetEntry(ref)?.private === true
          ? "its pinned version is a private capture; publish it or unpin first"
          : undefined,
    };
  }

  previewTransfer(userId: string, from: string, to: string) {
    this.authorizeTransfer(userId, from, to, false);
    return this.control.ownershipTransferService.preview(
      from,
      to,
      this.transferOptions,
    );
  }

  transfer(
    userId: string,
    from: string,
    to: string,
    selection: TransferSelection,
  ) {
    this.authorizeTransfer(userId, from, to, selection.secrets.length > 0);
    return this.control.ownershipTransferService.execute(
      from,
      to,
      selection,
      this.transferOptions,
    );
  }
}
