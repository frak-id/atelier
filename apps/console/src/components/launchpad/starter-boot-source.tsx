import {
  type PrebuildRecord,
  prebuildRepos,
  type StarterInput,
} from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { githubReposQuery } from "@/api/queries/github";
import { prebuildsListQuery } from "@/api/queries/prebuilds";
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
import {
  bootMode,
  type CustomBoot,
  customBootOf,
  matchStoredPrebuild,
  withCustomBoot,
  withStoredPrebuild,
} from "@/lib/starter-recipe";

type Recipe = StarterInput["recipe"];
type Mode = "stored" | "custom";

/**
 * What a starter boots from: a stored prebuild (followed by its spec, or
 * pinned by snapshot) or one set up here — a base image, any number of git
 * repos and setup steps, baked on the first launch. The mapping to the
 * recipe lives in `lib/starter-recipe.ts`.
 */
export function StarterBootSource({
  recipe,
  onChange,
  onValidityChange,
}: {
  recipe: Recipe;
  onChange: (recipe: Recipe) => void;
  /** False while the dev servers' JSON doesn't parse (block Save). */
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
  // The "set it up here" form survives a detour through the other mode.
  const [boot, setBoot] = useState<CustomBoot>(() =>
    customBootOf(recipe, defaultImage),
  );

  if (prebuildsQuery.isPending) return <Skeleton className="h-24 w-full" />;

  const mode = chosen ?? bootMode(recipe, prebuilds);
  const matched = matchStoredPrebuild(recipe, prebuilds);

  function commitBoot(next: CustomBoot) {
    setBoot(next);
    onChange(withCustomBoot(recipe, next));
  }

  function switchMode(next: Mode) {
    setChosen(next);
    if (next === "custom") onChange(withCustomBoot(recipe, boot));
  }

  /** Start "set it up here" from the stored prebuild's spec: the way to
   * tweak it (another repo, one more step) for this starter only. */
  function customize() {
    const next = customBootOf(recipe, defaultImage);
    setChosen("custom");
    commitBoot(next);
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
          onPick={(record) => onChange(withStoredPrebuild(recipe, record))}
          onCustomize={customize}
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

function StoredPrebuildPicker({
  prebuilds,
  recipe,
  matched,
  onPick,
  onCustomize,
}: {
  prebuilds: PrebuildRecord[];
  recipe: Recipe;
  matched: PrebuildRecord | undefined;
  onPick: (record: PrebuildRecord) => void;
  onCustomize: () => void;
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
        <RuntimeSurfaceField
          value={boot.surface}
          onChange={(surface) => onChange({ ...boot, surface })}
          onValidityChange={onValidityChange}
          hint={
            <>
              The projects' dev servers, in the toolbox scheme: a{" "}
              <code>cwd</code> in the clone path, <code>"lazy": true</code> to
              start it when its tool is first opened, and a public port to point
              a tool at. It must listen on <code>0.0.0.0</code>.
            </>
          }
          placeholders={{
            processes:
              '[{"name":"web","command":"bun run dev","cwd":"/home/dev/web","user":"dev","lazy":true,"readiness":{"port":5173}}]',
            ports:
              '[{"name":"web","port":5173,"public":true,"auth":"forward"}]',
          }}
        />
      ) : null}
      <p className="text-xs text-muted-foreground">
        {baked
          ? "The first launch builds this (it can take a few minutes); later launches reuse it until a repository gets a new commit."
          : "Boots straight from the image: nothing to clone or build."}
      </p>
    </div>
  );
}
