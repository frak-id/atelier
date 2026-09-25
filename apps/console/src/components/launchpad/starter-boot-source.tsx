import {
  canonicalJson,
  type LaunchpadService,
  type PrebuildRecord,
  type PrebuildSpec,
  prebuildRepos,
  type RuntimeSurface,
  runtimeSurfaceOf,
  type StarterInput,
} from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Pencil, Save, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { githubReposQuery } from "@/api/queries/github";
import {
  prebuildsListQuery,
  useSavePrebuildSurface,
} from "@/api/queries/prebuilds";
import { ImageSourcePicker } from "@/components/image-source-picker";
import { ReposField } from "@/components/repos-field";
import { RuntimeSurfaceField } from "@/components/runtime-surface-field";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { useDefaultImage } from "@/hooks/use-repo-catalog";
import { prebuildRepoLabel, prebuildTitle } from "@/lib/formatters";
import { cloneCwds } from "@/lib/runtime-surface";
import {
  bootMode,
  type CustomBoot,
  customBootOf,
  matchStoredPrebuild,
  orphanedTools,
  withCustomBoot,
  withStoredPrebuild,
} from "@/lib/starter-recipe";

type Recipe = StarterInput["recipe"];
type Mode = "stored" | "custom";

/**
 * What a starter boots from: a stored prebuild (followed by its recipe, or
 * pinned by snapshot) or one set up here — a base image, any number of git
 * repos and setup steps, baked on the first launch. The mapping to the
 * recipe lives in `lib/starter-recipe.ts`.
 *
 * A followed prebuild's dev servers stay the prebuild's: they're edited here
 * in place (`PrebuildDevServers`) and reach every starter following it.
 */
export function StarterBootSource({
  recipe,
  services,
  onChange,
  onValidityChange,
}: {
  recipe: Recipe;
  /** The starter's tools: warned about when a dev-server edit would leave
   * one with nothing to open. */
  services: LaunchpadService[];
  onChange: (recipe: Recipe) => void;
  /** False while a dev-servers form has a blocking issue, or unsaved
   * changes to a followed prebuild's (block Save). */
  onValidityChange: (valid: boolean) => void;
}) {
  const defaultImage = useDefaultImage();
  const prebuildsQuery = useQuery(prebuildsListQuery());
  const prebuilds = prebuildsQuery.data ?? [];
  const { data: githubRepos } = useQuery(githubReposQuery());
  const urlSuggestions = (githubRepos?.repos ?? []).map((r) => r.cloneUrl);
  // Detected from the recipe until the author picks a mode, so a starter
  // that follows a stored prebuild opens on it once the list has loaded.
  const [chosen, setChosen] = useState<Mode>();
  // The "set it up here" form once edited, so it survives a detour through
  // the other mode. Until then it's read from the recipe (with a followed
  // prebuild's current dev servers, known once the list has loaded).
  const [draft, setDraft] = useState<CustomBoot>();
  // Unsaved edits to the followed prebuild's dev servers, kept here (not in
  // the form) so no other action can drop them silently.
  const [devDraft, setDevDraft] = useState<DevServersDraft>();

  if (prebuildsQuery.isPending) return <Skeleton className="h-24 w-full" />;

  const mode = chosen ?? bootMode(recipe, prebuilds);
  const matched = matchStoredPrebuild(recipe, prebuilds);
  const boot = draft ?? customBootOf(recipe, defaultImage, prebuilds);
  // Only while it still applies: the picked prebuild, in this mode.
  const pendingDevServers =
    mode === "stored" && devDraft && devDraft.ref === matched?.ref
      ? devDraft.surface
      : undefined;

  function commitBoot(next: CustomBoot) {
    setDraft(next);
    onChange(withCustomBoot(recipe, next));
  }

  /** Into "set it up here" from `from`. Unsaved dev-server edits come
   * along: they become the starter's own instead of being lost. */
  function toCustom(from: CustomBoot) {
    setChosen("custom");
    setDevDraft(undefined);
    commitBoot(
      pendingDevServers ? { ...from, surface: pendingDevServers } : from,
    );
  }

  function switchMode(next: Mode) {
    if (next === "custom") toCustom(boot);
    else setChosen(next);
  }

  /** Start "set it up here" from the stored prebuild's spec and current dev
   * servers: the way to tweak it (another repo, one more step, its own dev
   * servers) for this starter only. */
  function customize() {
    toCustom(customBootOf(recipe, defaultImage, prebuilds));
  }

  return (
    <div className="space-y-3">
      <SegmentedControl
        options={[
          { value: "stored", label: "A stored prebuild" },
          { value: "custom", label: "Set it up here" },
        ]}
        value={mode}
        onChange={switchMode}
      />
      {mode === "stored" ? (
        <StoredPrebuildPicker
          prebuilds={prebuilds}
          recipe={recipe}
          matched={matched}
          services={services}
          devServersDraft={pendingDevServers}
          onDevServersDraft={(surface) =>
            setDevDraft(
              surface && matched ? { ref: matched.ref, surface } : undefined,
            )
          }
          onPick={(record) => onChange(withStoredPrebuild(recipe, record))}
          onCustomize={customize}
          onValidityChange={onValidityChange}
        />
      ) : (
        <CustomBootSource
          boot={boot}
          baked={recipe.prebuild !== undefined}
          onChange={commitBoot}
          onValidityChange={onValidityChange}
          urlSuggestions={urlSuggestions}
        />
      )}
    </div>
  );
}

/** Unsaved dev servers for the stored prebuild `ref`. */
interface DevServersDraft {
  ref: string;
  surface: RuntimeSurface;
}

function StoredPrebuildPicker({
  prebuilds,
  recipe,
  matched,
  services,
  devServersDraft,
  onDevServersDraft,
  onPick,
  onCustomize,
  onValidityChange,
}: {
  prebuilds: PrebuildRecord[];
  recipe: Recipe;
  matched: PrebuildRecord | undefined;
  services: LaunchpadService[];
  /** Unsaved edits to `matched`'s dev servers (undefined: none). */
  devServersDraft: RuntimeSurface | undefined;
  onDevServersDraft: (surface: RuntimeSurface | undefined) => void;
  onPick: (record: PrebuildRecord) => void;
  onCustomize: () => void;
  onValidityChange: (valid: boolean) => void;
}) {
  if (prebuilds.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No prebuilds yet. Create one under Settings → Prebuilds, or set one up
        here.
      </p>
    );
  }
  const pinned =
    "snapshot" in recipe.source ? recipe.source.snapshot : undefined;
  return (
    <div className="space-y-2">
      <NativeSelect
        value={matched?.ref ?? ""}
        onChange={(e) => {
          const record = prebuilds.find((p) => p.ref === e.target.value);
          if (record) onPick(record);
        }}
        // Another prebuild would leave the dev-server edits behind.
        disabled={devServersDraft !== undefined}
        title={
          devServersDraft ? "Save or undo the dev servers first" : undefined
        }
        aria-label="Prebuild"
      >
        <option value="" disabled>
          Pick a prebuild…
        </option>
        {prebuilds.map((p) => (
          <option key={p.ref} value={p.ref}>
            {prebuildTitle(p)}
          </option>
        ))}
      </NativeSelect>
      <p
        className={
          pinned && !matched
            ? "text-xs text-warning"
            : "text-xs text-muted-foreground"
        }
      >
        {matched && !pinned ? (
          "Follows this prebuild: when it's rebuilt, new workspaces get the fresh one."
        ) : matched ? (
          "A hand-made snapshot: pinned as-is (it has no recipe to rebuild)."
        ) : pinned ? (
          <>
            Pinned to <code>{pinned}</code>, which no longer exists. Pick
            another one.
          </>
        ) : (
          "Pick one. Until you do, the starter keeps its current set-up."
        )}
      </p>
      {matched ? (
        <PrebuildSummary prebuild={matched} onCustomize={onCustomize} />
      ) : null}
      {matched?.spec ? (
        <PrebuildDevServers
          // Its own field state (validity) per prebuild.
          key={matched.ref}
          prebuildRef={matched.ref}
          spec={matched.spec}
          draft={devServersDraft}
          onDraftChange={onDevServersDraft}
          services={services}
          onValidityChange={onValidityChange}
        />
      ) : null}
    </div>
  );
}

function sameSurface(a: RuntimeSurface, b: RuntimeSurface): boolean {
  return (
    canonicalJson(runtimeSurfaceOf(a)) === canonicalJson(runtimeSurfaceOf(b))
  );
}

/**
 * The followed prebuild's dev servers, edited in place. They belong to the
 * prebuild (every starter and sandbox booting it runs them), so they save
 * on it, apart from the starter and without a rebuild (`PATCH
 * /v1/prebuilds/:ref/surface`), and reach new workspaces on their next
 * launch. The starter's Save waits while they have unsaved changes (the
 * draft is the parent's, so no other action drops it silently).
 */
function PrebuildDevServers({
  prebuildRef,
  spec,
  draft,
  onDraftChange,
  services,
  onValidityChange,
}: {
  prebuildRef: string;
  spec: PrebuildSpec;
  draft: RuntimeSurface | undefined;
  /** `undefined`: back to what the prebuild has. */
  onDraftChange: (surface: RuntimeSurface | undefined) => void;
  services: LaunchpadService[];
  onValidityChange: (valid: boolean) => void;
}) {
  const save = useSavePrebuildSurface();
  // What the prebuild has, as listed: a save (or anyone else's edit, on the
  // next refetch) shows up here.
  const saved = runtimeSurfaceOf(spec);
  const value = draft ?? saved;
  const dirty = draft !== undefined;
  const [fieldValid, setFieldValid] = useState(true);
  const orphaned = orphanedTools(services, saved, value);
  const cwds = cloneCwds(spec.repos);

  useEffect(() => {
    onValidityChange(fieldValid && !dirty);
  }, [fieldValid, dirty, onValidityChange]);
  // Gone (another prebuild, "set it up here"): nothing left to block on.
  useEffect(() => () => onValidityChange(true), [onValidityChange]);

  function edit(next: RuntimeSurface) {
    onDraftChange(sameSurface(next, saved) ? undefined : next);
  }

  function handleSave() {
    if (!draft) return;
    // The mutation writes the saved surface into the list first.
    save.mutate(
      { ref: prebuildRef, surface: draft },
      { onSuccess: () => onDraftChange(undefined) },
    );
  }

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <Label>Dev servers</Label>
        <p className="text-xs text-muted-foreground">
          The prebuild's own: every starter and sandbox booting it runs them,
          and a change reaches their next launch. Saved on the prebuild, without
          a rebuild.
        </p>
      </div>
      <RuntimeSurfaceField
        value={value}
        onChange={edit}
        onValidityChange={setFieldValid}
        defaults={{ user: "dev", lazy: true, cwd: cwds[0] }}
        cwdSuggestions={cwds}
        emptyText="No dev servers: workspaces boot with just the cloned code."
        hint="Give a server a public port to point a tool at it below."
      />
      {orphaned.length > 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {orphaned.map((s) => `“${s.label || s.id}”`).join(", ")} would have
            nothing to open:{" "}
            {orphaned.length > 1
              ? "their ports are no longer served publicly."
              : "its port is no longer served publicly."}{" "}
            Other starters following this prebuild may use it too.
          </span>
        </p>
      ) : null}
      {dirty ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            loading={save.isPending}
            disabled={!fieldValid}
            onClick={handleSave}
          >
            <Save />
            Save dev servers
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => onDraftChange(undefined)}
          >
            <Undo2 />
            Undo
          </Button>
          <span className="text-xs text-muted-foreground">
            Save or undo them before saving the starter.
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** What the picked prebuild contains, with "Customize" when it has a spec
 * to start from (a hand-made snapshot has none). */
function PrebuildSummary({
  prebuild,
  onCustomize,
}: {
  prebuild: PrebuildRecord;
  onCustomize: () => void;
}) {
  const { spec } = prebuild;
  const repos = prebuildRepos(prebuild);
  const servedPorts = (spec?.ports ?? []).filter((port) => port.public);
  return (
    <div className="space-y-1.5 rounded-md border p-3 text-sm">
      <p className="text-muted-foreground">
        Base image:{" "}
        <code>
          {spec && "image" in spec.source ? spec.source.image : prebuild.image}
        </code>
      </p>
      {repos.length > 0 ? (
        <ul className="space-y-0.5">
          {repos.map((repo) => (
            <li
              key={repo.clonePath}
              className="font-mono text-xs text-muted-foreground"
            >
              {prebuildRepoLabel(repo)} → {repo.clonePath}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No repos cloned.</p>
      )}
      {servedPorts.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Serves{" "}
          {servedPorts.map((port, i) => (
            <span key={port.name}>
              {i > 0 ? ", " : ""}
              <code>{port.name}</code>
            </span>
          ))}
          : pick them for tools below.
        </p>
      ) : null}
      {spec ? (
        <Button type="button" variant="outline" size="sm" onClick={onCustomize}>
          <Pencil />
          Customize
        </Button>
      ) : null}
    </div>
  );
}

function CustomBootSource({
  boot,
  baked,
  onChange,
  onValidityChange,
  urlSuggestions,
}: {
  boot: CustomBoot;
  /** Something to clone or build: the first launch bakes it. */
  baked: boolean;
  onChange: (boot: CustomBoot) => void;
  onValidityChange: (valid: boolean) => void;
  urlSuggestions: string[];
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Base image</Label>
        <ImageSourcePicker
          value={{ image: boot.image }}
          allowSnapshot={false}
          onChange={(source) =>
            onChange({
              ...boot,
              image: "image" in source ? source.image : boot.image,
            })
          }
        />
      </div>
      <div className="space-y-1">
        <Label>Git repositories</Label>
        <ReposField
          repos={boot.repos}
          onChange={(repos) => onChange({ ...boot, repos })}
          urlSuggestions={urlSuggestions}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="starter-setup-steps">Setup steps (one per line)</Label>
        <textarea
          id="starter-setup-steps"
          value={boot.steps}
          onChange={(e) => onChange({ ...boot, steps: e.target.value })}
          spellCheck={false}
          placeholder="cd web && bun install"
          className="min-h-24 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Run in order from the home directory. A step usually starts with{" "}
          <code>cd &lt;clone path&gt; &amp;&amp;</code>.
        </p>
      </div>
      {boot.repos.some((r) => r.url.trim()) ? (
        <div className="space-y-1">
          <Label>Dev servers</Label>
          <RuntimeSurfaceField
            value={boot.surface}
            onChange={(surface) => onChange({ ...boot, surface })}
            onValidityChange={onValidityChange}
            defaults={{
              user: "dev",
              lazy: true,
              cwd: cloneCwds(boot.repos)[0],
            }}
            cwdSuggestions={cloneCwds(boot.repos)}
            emptyText="No dev servers yet."
            hint="Give a server a public port to point a tool at it below."
          />
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {baked
          ? "The first launch builds this (it can take a few minutes); later launches reuse it until a repository gets a new commit."
          : "Boots straight from the image: nothing to clone or build."}
      </p>
    </div>
  );
}
