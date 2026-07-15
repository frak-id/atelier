import type { PrebuildRecord, Source } from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Layers, Loader2 } from "lucide-react";
import { useState } from "react";
import { imagesListQuery } from "@/api/queries/images";
import { prebuildsListQuery } from "@/api/queries/prebuilds";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";

type ImageStatus = "building" | "ready" | "error";

const STATUS_VARIANT: Record<ImageStatus, BadgeVariant> = {
  building: "info",
  ready: "success",
  error: "destructive",
};

function isSnapshotSource(source: Source): source is { snapshot: string } {
  return "snapshot" in source;
}

/** Short, human summary of a prebuild's opaque metadata (workspace/repo…). */
function metadataSummary(metadata?: Record<string, string>): string | null {
  if (!metadata) return null;
  const entries = Object.entries(metadata);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}: ${v}`).join(" · ");
}

/**
 * The boot-source picker shared by the prebuild and toolbox editors. `source`
 * is exactly one of `{ image }` (an OCI base image, picked from the server's
 * built/registered images) or `{ snapshot }` (chaining onto an existing
 * prebuild). Kept purely presentational over the passed `value`/`onChange` so
 * both editors keep JSON as their source of truth.
 */
export function ImageSourcePicker({
  value,
  onChange,
  allowSnapshot = true,
}: {
  value: Source;
  onChange: (source: Source) => void;
  /** Toolboxes only ever source from an image; prebuilds may chain snapshots. */
  allowSnapshot?: boolean;
}) {
  const snapshot = isSnapshotSource(value);
  const mode: "image" | "snapshot" = snapshot ? "snapshot" : "image";

  // Remember each mode's last ref so toggling back and forth restores the
  // previous selection instead of blanking it.
  const [lastImage, setLastImage] = useState(snapshot ? "" : value.image);
  const [lastSnapshot, setLastSnapshot] = useState(
    snapshot ? value.snapshot : "",
  );

  return (
    <div className="space-y-3">
      {allowSnapshot ? (
        <SegmentedControl
          options={[
            { value: "image", label: "Base image" },
            { value: "snapshot", label: "Chain a prebuild" },
          ]}
          value={mode}
          onChange={(next) =>
            onChange(
              next === "snapshot"
                ? { snapshot: lastSnapshot }
                : { image: lastImage },
            )
          }
        />
      ) : null}
      {mode === "image" ? (
        <ImageGrid
          selected={snapshot ? "" : value.image}
          onSelect={(image) => {
            setLastImage(image);
            onChange({ image });
          }}
        />
      ) : (
        <SnapshotGrid
          selected={snapshot ? value.snapshot : ""}
          onSelect={(ref) => {
            setLastSnapshot(ref);
            onChange({ snapshot: ref });
          }}
        />
      )}
    </div>
  );
}

function ImageGrid({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (image: string) => void;
}) {
  const {
    data: images,
    isPending,
    isError,
    error,
  } = useQuery(imagesListQuery());

  return (
    <div className="space-y-2">
      {isPending ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load images"}
        </p>
      ) : !images || images.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No images yet. Add one under Settings → Images.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {images.map((image) => {
            const status = image.status as ImageStatus;
            const isSelected = image.name === selected;
            return (
              <button
                key={image.name}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelect(image.name)}
                className={cn(
                  "flex flex-col gap-1 rounded-md border p-3 text-left transition-colors hover:border-primary/60",
                  isSelected && "border-primary ring-1 ring-primary",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Boxes className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-sm">
                    {image.name}
                  </span>
                  <Badge variant={STATUS_VARIANT[status] ?? "neutral"}>
                    {status === "building" ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : null}
                    {status}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">{image.provenance}</Badge>
                  <span>{formatRelativeTime(image.createdAt)}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
      <div className="space-y-1">
        <label
          htmlFor="image-source-manual"
          className="text-xs text-muted-foreground"
        >
          Or type an image ref
        </label>
        <Input
          id="image-source-manual"
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
          placeholder="dev-base-v2"
          className="font-mono"
        />
      </div>
    </div>
  );
}

function SnapshotGrid({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (ref: string) => void;
}) {
  const {
    data: prebuilds,
    isPending,
    isError,
    error,
  } = useQuery(prebuildsListQuery());

  if (isPending) return <Skeleton className="h-16 w-full" />;
  if (isError) {
    return (
      <p className="text-sm text-destructive">
        {error instanceof Error ? error.message : "Failed to load prebuilds"}
      </p>
    );
  }
  if (!prebuilds || prebuilds.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No prebuilds to chain from yet.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {prebuilds.map((prebuild: PrebuildRecord) => {
        const summary = metadataSummary(prebuild.metadata);
        const isSelected = prebuild.ref === selected;
        return (
          <button
            key={prebuild.ref}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onSelect(prebuild.ref)}
            className={cn(
              "flex flex-col gap-1 rounded-md border p-3 text-left transition-colors hover:border-primary/60",
              isSelected && "border-primary ring-1 ring-primary",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Layers className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium text-sm">
                {summary ?? prebuild.ref}
              </span>
              {prebuild.parent ? (
                <Badge variant="outline">chained</Badge>
              ) : null}
            </div>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {prebuild.ref}
            </span>
          </button>
        );
      })}
    </div>
  );
}
