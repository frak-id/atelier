import type { PrebuildRecord, StarterInput } from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { prebuildsListQuery } from "@/api/queries/prebuilds";
import { ImageSourcePicker } from "@/components/image-source-picker";
import { NativeSelect } from "@/components/ui/native-select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useDefaultImage } from "@/hooks/use-repo-catalog";
import { prebuildTitle } from "@/lib/formatters";

/** The stored prebuild the recipe currently points at, if any: by recipe
 * (the follow-updates form) or by pinned snapshot ref. */
function matchPrebuild(
  recipe: StarterInput["recipe"],
  prebuilds: PrebuildRecord[],
): PrebuildRecord | undefined {
  if (recipe.prebuild) {
    const want = JSON.stringify(recipe.prebuild);
    return prebuilds.find((p) => p.spec && JSON.stringify(p.spec) === want);
  }
  if ("snapshot" in recipe.source) {
    const ref = recipe.source.snapshot;
    return prebuilds.find((p) => p.ref === ref);
  }
  return undefined;
}

/** What a starter boots from: a stored prebuild (followed by recipe, or
 * pinned by snapshot) or a base image. */
export function StarterBootSource({
  recipe,
  onChange,
}: {
  recipe: StarterInput["recipe"];
  onChange: (recipe: StarterInput["recipe"]) => void;
}) {
  const defaultImage = useDefaultImage();
  const { data: prebuilds = [] } = useQuery(prebuildsListQuery());
  const usesPrebuild = !!recipe.prebuild || "snapshot" in recipe.source;
  const [mode, setMode] = useState<"prebuild" | "image">(
    usesPrebuild ? "prebuild" : "image",
  );
  const matched = matchPrebuild(recipe, prebuilds);

  function pickPrebuild(ref: string) {
    const record = prebuilds.find((p) => p.ref === ref);
    if (!record) return;
    const { prebuild: _drop, ...rest } = recipe;
    // With the recipe stored, every launch re-resolves it (a cache hit when
    // unchanged), so a rebuilt prebuild reaches new workspaces. Hand-made
    // snapshots without a recipe can only be pinned.
    onChange(
      record.spec
        ? { ...rest, source: record.spec.source, prebuild: record.spec }
        : { ...rest, source: { snapshot: record.ref } },
    );
  }

  function switchMode(next: "prebuild" | "image") {
    setMode(next);
    if (next === "image") {
      const { prebuild: _drop, ...rest } = recipe;
      onChange({
        ...rest,
        source:
          "image" in recipe.source && !recipe.prebuild
            ? recipe.source
            : { image: defaultImage },
      });
    }
  }

  return (
    <div className="space-y-2">
      <SegmentedControl
        options={[
          { value: "prebuild", label: "A prebuild" },
          { value: "image", label: "A base image" },
        ]}
        value={mode}
        onChange={switchMode}
      />
      {mode === "prebuild" ? (
        prebuilds.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No prebuilds yet. Create one under Settings → Prebuilds.
          </p>
        ) : (
          <>
            <NativeSelect
              value={matched?.ref ?? ""}
              onChange={(e) => pickPrebuild(e.target.value)}
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
            {recipe.prebuild ? (
              <p className="text-xs text-muted-foreground">
                Follows this prebuild: when it's rebuilt, new workspaces get the
                fresh one.
              </p>
            ) : "snapshot" in recipe.source && !matched ? (
              <p className="text-xs text-warning">
                Pinned to <code>{recipe.source.snapshot}</code>, which no longer
                exists. Pick another one.
              </p>
            ) : null}
          </>
        )
      ) : (
        <ImageSourcePicker
          value={"image" in recipe.source ? recipe.source : { image: "" }}
          allowSnapshot={false}
          onChange={(source) => onChange({ ...recipe, source })}
        />
      )}
    </div>
  );
}
