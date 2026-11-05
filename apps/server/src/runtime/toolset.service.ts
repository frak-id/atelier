/**
 * Toolsets: reproducible artifacts (a home path-set tarred and pushed to the
 * registry) built in a throwaway pod, refreshed without a live sandbox, or
 * captured from a running one — plus the record bookkeeping (publish, delete
 * with its GC guard). Shares only the build-pod flow and the source resolver
 * with the prebuild code.
 */
import { createHash } from "node:crypto";
import type {
  ToolsetBuildRequest,
  ToolsetCaptureRequest,
  ToolsetEntry,
  ToolsetRef,
  ToolsetRefreshRequest,
  ToolsetRefreshResult,
} from "@atelier/spec";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../shared/errors.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import {
  defaultImage,
  qualifyImageName,
} from "../shared/lib/runtime-config.ts";
import type { AgentClient } from "./agent/index.ts";
import { type BuildPods, type OnLog, toolsetToSpec } from "./build-pod.ts";
import type { SourceResolver } from "./source-resolver.ts";
import { resolveToolsetRef } from "./spec-guards.ts";
import type {
  SandboxStore,
  SandboxToolsetRefStore,
  ToolsetRecord,
  ToolsetStore,
} from "./store.ts";
import { fingerprintScript, parseFingerprint } from "./toolset-fingerprint.ts";

const log = createChildLogger("runtime-toolset");

export interface ToolsetDeps {
  agent: AgentClient;
  sandboxes: SandboxStore;
  toolsets: ToolsetStore;
  sandboxToolsetRefs: SandboxToolsetRefStore;
  resolver: SourceResolver;
  buildPods: BuildPods;
}

/** Drop the internal `hash` (dedup key) so the listed shape matches the
 * `ToolsetEntry` wire schema (`additionalProperties: false`). */
function toEntry(record: ToolsetRecord): ToolsetEntry {
  const { hash: _hash, ...entry } = record;
  return entry;
}

function hashToolset(req: ToolsetBuildRequest): string {
  // `name` IS keyed: it's the artifact's registry repo (own tag namespace,
  // own retention window), and the stored ref embeds it — so two names must
  // build two artifacts, not alias onto the first-built ref. `env` is
  // build-time secret material, excluded like `PrebuildSpec.env`.
  const keyed = {
    name: req.name,
    source: req.source ?? null,
    build: req.build,
    paths: req.paths,
  };
  return createHash("sha256").update(JSON.stringify(keyed)).digest("hex");
}

/** Result-keyed hash for captures and refreshes: the digest is the identity,
 * scoped by name (two names can capture byte-identical content and must stay
 * two records, not an overwrite). */
function resultHash(name: string, digest: string): string {
  return createHash("sha256").update(`${name}\u0000${digest}`).digest("hex");
}

export class ToolsetService {
  private readonly agent: AgentClient;
  private readonly sandboxes: SandboxStore;
  private readonly toolsets: ToolsetStore;
  private readonly sandboxToolsetRefs: SandboxToolsetRefStore;
  private readonly resolver: SourceResolver;
  private readonly buildPods: BuildPods;
  /** De-dupes concurrent built-toolset executions by content hash (the temp
   * pod name is deterministic and would otherwise collide). */
  private readonly inflight = new Map<string, Promise<ToolsetRef>>();

  constructor(deps: ToolsetDeps) {
    this.agent = deps.agent;
    this.sandboxes = deps.sandboxes;
    this.toolsets = deps.toolsets;
    this.sandboxToolsetRefs = deps.sandboxToolsetRefs;
    this.resolver = deps.resolver;
    this.buildPods = deps.buildPods;
  }

  /**
   * Build a reproducible, input-keyed toolset artifact
   * (composed-prebuild-volumes.md §2). Runs `build[]` in a throwaway pod (as
   * `dev`, so tools land in the home), then has the agent tar the `paths[]`
   * and `oras push` them to the registry. Idempotent: keyed by
   * `hash(source ⊕ build ⊕ paths)`; a hit returns instantly; concurrent builds
   * for the same hash dedupe onto one execution.
   */
  async build(
    req: ToolsetBuildRequest,
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<ToolsetRef> {
    const hash = hashToolset(req);
    const existing = this.toolsets.getByHash(hash);
    if (existing) return { ref: existing.ref };
    const inflight = this.inflight.get(hash);
    if (inflight) return inflight;
    const run = this.executeBuild(req, hash, signal, onLog).finally(() => {
      this.inflight.delete(hash);
    });
    this.inflight.set(hash, run);
    return run;
  }

  private async executeBuild(
    req: ToolsetBuildRequest,
    hash: string,
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<ToolsetRef> {
    const source = req.source ?? { image: defaultImage() };
    const { image, snapshotName } = await this.resolver.resolveSource(source);
    const tempId = `ts-${hash.slice(0, 12)}`;
    const target = `${qualifyImageName(`toolsets/${req.name}`)}:${hash.slice(0, 12)}`;

    return this.buildPods.withThrowawayPod(
      tempId,
      toolsetToSpec(source, req.env),
      { image, snapshotName },
      "toolset build pod cleanup failed",
      async () => {
        // Build steps run as `dev` so installs land in the home path-sets the
        // artifact captures (running as root would scatter bytes into /root).
        for (const step of req.build) {
          signal?.throwIfAborted();
          await this.buildPods.execStep(tempId, step, "dev", signal, onLog);
        }
        signal?.throwIfAborted();
        onLog?.("Packing and pushing toolset artifact…");
        const { digest } = await this.agent.buildToolset(
          tempId,
          { target, paths: req.paths },
          signal,
        );
        const ref = `toolsets/${req.name}@${digest}`;
        this.toolsets.put({
          hash,
          name: req.name,
          ref,
          paths: req.paths,
          provenance: { kind: "built", build: req.build },
          private: false,
          createdAt: new Date().toISOString(),
        });
        log.info({ ref, hash, name: req.name }, "toolset artifact built");
        return { ref };
      },
    );
  }

  /**
   * Refresh a toolset without a live sandbox (docs/toolbox-versions.md
   * §10): boot a throwaway pod with `base` materialized into the home, run
   * `steps` as `dev`, then capture `paths` through the agent's capture route
   * (same default excludes + secret scan as a sandbox capture). The paths
   * are fingerprinted before and after the steps; when both are known and
   * equal, nothing is pushed and the result is `changed: false`. An unknown
   * fingerprint never skips: it captures, at worst an extra version.
   * Result-keyed and private like a capture: the caller decides on publish.
   */
  async refresh(
    req: ToolsetRefreshRequest,
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<ToolsetRefreshResult> {
    if (req.steps.length === 0) {
      throw new ValidationError("a toolset refresh needs at least one step");
    }
    if (req.paths.length === 0) {
      throw new ValidationError("a toolset refresh needs paths to capture");
    }
    // Built before the pod boots: a bad path fails fast, not after a boot.
    const fingerprint = fingerprintScript(req.paths);
    const source = req.source ?? { image: defaultImage() };
    const { image, snapshotName } = await this.resolver.resolveSource(source);
    const tempId = `tr-${safeNanoid()}`;
    const target = `${qualifyImageName(`toolsets/${req.name}`)}:refresh-${safeNanoid()}`;

    return this.buildPods.withThrowawayPod(
      tempId,
      toolsetToSpec(source),
      {
        image,
        snapshotName,
        toolsets: [resolveToolsetRef(req.base.ref)],
      },
      "toolset refresh pod cleanup failed",
      async () => {
        onLog?.(`Starting from ${req.base.ref}`);
        const before = await this.fingerprintPaths(tempId, fingerprint, signal);
        for (const step of req.steps) {
          signal?.throwIfAborted();
          await this.buildPods.execStep(tempId, step, "dev", signal, onLog);
        }
        signal?.throwIfAborted();
        const after = await this.fingerprintPaths(tempId, fingerprint, signal);
        if (before !== undefined && before === after) {
          onLog?.("Nothing changed in the toolset paths; nothing to save.");
          log.info(
            { name: req.name, base: req.base.ref },
            "toolset refresh: unchanged",
          );
          return { changed: false };
        }
        onLog?.(`Capturing ${req.paths.join(", ")}…`);
        const { digest } = await this.agent.captureToolset(
          tempId,
          { target, paths: req.paths, exclude: [], overrides: [] },
          signal,
        );
        const ref = `toolsets/${req.name}@${digest}`;
        this.toolsets.put({
          hash: resultHash(req.name, digest),
          name: req.name,
          ref,
          paths: req.paths,
          provenance: {
            kind: "refreshed",
            base: req.base.ref,
            steps: req.steps,
          },
          private: true,
          createdAt: new Date().toISOString(),
        });
        onLog?.(`Pushed ${ref}`);
        log.info({ ref, base: req.base.ref }, "toolset refreshed");
        return { changed: true, ref };
      },
    );
  }

  /** Hash a throwaway pod's toolset paths (`toolset-fingerprint.ts`), or
   * `undefined` when it can't be told (the exec failed or printed no
   * hash): the caller then treats the content as changed. */
  private async fingerprintPaths(
    tempId: string,
    script: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const res = await this.agent.exec(tempId, script, {
        timeout: 300_000,
        user: "dev",
        workdir: "/home/dev",
        signal,
      });
      const value =
        res.exitCode === 0 ? parseFingerprint(res.stdout) : undefined;
      if (value === undefined) {
        log.warn(
          { tempId, exitCode: res.exitCode, stderr: res.stderr.slice(0, 500) },
          "toolset fingerprint unavailable; treating as changed",
        );
      }
      return value;
    } catch (err) {
      signal?.throwIfAborted();
      log.warn({ tempId, err }, "toolset fingerprint failed");
      return undefined;
    }
  }

  list(): ToolsetEntry[] {
    return this.toolsets.list().map(toEntry);
  }

  /** Look up a single toolset by ref (control-side guards, e.g. the org
   * publish-before-pin check, need to inspect one entry without listing
   * everything). */
  getEntry(ref: string): ToolsetEntry | undefined {
    const record = this.toolsets.getByRef(ref);
    return record ? toEntry(record) : undefined;
  }

  /** Publish a toolset to the org (flip `private` off) — the explicit sharing
   * step for a private-by-default capture (proposal §2). */
  publish(ref: string): ToolsetEntry {
    const record = this.toolsets.getByRef(ref);
    if (!record) throw new NotFoundError("Toolset", ref);
    const next: ToolsetRecord = { ...record, private: false };
    this.toolsets.put(next);
    return toEntry(next);
  }

  /** Delete a toolset record. Refuses when a live/paused sandbox still has it
   * mounted (toolset-overlay-squashfs.md §7): deleting it out from under one
   * would 404 a future `getByRef`/compose lookup for that ref. The registry
   * blob itself is left to zot retention/GC; this only drops the runtime's
   * handle to it. The mount set is the `sandbox_toolset_refs` join, populated
   * on every successful create/resume boot and cleared on destroy. */
  delete(ref: string): void {
    const record = this.toolsets.getByRef(ref);
    if (!record) throw new NotFoundError("Toolset", ref);
    if (this.sandboxToolsetRefs.referencedRefs().has(ref)) {
      throw new ConflictError(
        `Toolset ${ref} is mounted by a live or paused sandbox and cannot be deleted.`,
      );
    }
    this.toolsets.delete(record.hash);
  }

  /**
   * Capture a live sandbox's declared path-sets into a toolset artifact
   * (composed-prebuild-volumes.md §2 "captured (result-keyed)"). The agent
   * tars `paths` minus the merged exclude globs, secret-scans the included
   * files, and pushes — no baseline diff (there's nothing to diff against at
   * capture time). Result-keyed: unlike `build`, there is no content hash to
   * dedupe on — every capture is a distinct artifact, so it is never
   * silently evictable and is stored private-to-the-capturing-sandbox by
   * default (org publish is a separate, explicit step).
   */
  async capture(
    id: string,
    req: ToolsetCaptureRequest,
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<ToolsetRef> {
    if (!this.sandboxes.get(id)) throw new NotFoundError("Sandbox", id);
    const target = `${qualifyImageName(`toolsets/${req.name}`)}:cap-${safeNanoid()}`;
    onLog?.(`Capturing ${req.paths.join(", ")} from ${id}…`);
    const { digest } = await this.agent.captureToolset(
      id,
      {
        target,
        paths: req.paths,
        exclude: req.exclude ?? [],
        overrides: req.overrides ?? [],
      },
      signal,
    );
    onLog?.(`Pushed ${req.name}@${digest}`);
    const ref = `toolsets/${req.name}@${digest}`;
    this.toolsets.put({
      hash: resultHash(req.name, digest),
      name: req.name,
      ref,
      paths: req.paths,
      provenance: { kind: "captured", capturedFrom: id },
      private: true,
      createdAt: new Date().toISOString(),
    });
    log.info({ ref, sandboxId: id, name: req.name }, "toolset captured");
    return { ref };
  }
}
