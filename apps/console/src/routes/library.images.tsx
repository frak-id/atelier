import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Boxes,
  ChevronDown,
  ChevronUp,
  Hammer,
  Loader2,
  Package,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import {
  imageLogsQuery,
  imagesListQuery,
  imageTemplatesQuery,
  useBuildSeed,
  useDeleteImage,
  useRegisterImage,
} from "@/api/queries/images";
import { JobStatus } from "@/components/job-status";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { formatRelativeTime } from "@/lib/formatters";

export const Route = createFileRoute("/library/images")({
  component: ImagesPage,
});

type ImageStatus = "building" | "ready" | "error";

const STATUS_VARIANT: Record<ImageStatus, BadgeVariant> = {
  building: "info",
  ready: "success",
  error: "destructive",
};

const PROVENANCE_LABEL: Record<string, string> = {
  seed: "seed",
  dockerfile: "dockerfile",
  external: "external",
};

function ImagesPage() {
  // Building, registering and deleting images are server-admin actions.
  const isAdmin = useIsAdmin();
  return (
    <div className="space-y-3">
      {isAdmin ? <TemplatesCard /> : null}
      <ImagesCard isAdmin={isAdmin} />
      {isAdmin ? <RegisterImageCard /> : null}
    </div>
  );
}

/** Embedded seed Dockerfiles the server ships but never builds itself — the
 * batteries-included option beside BYO. Building runs in the operator's own
 * cluster and pushes to their configured registry. */
function TemplatesCard() {
  const {
    data: templates,
    isPending,
    isError,
    error,
  } = useQuery(imageTemplatesQuery());
  const buildSeed = useBuildSeed();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Base image templates</CardTitle>
        <CardDescription>
          Dockerfile+context bundles embedded in the server. Build one to push
          it to your own registry — nothing is built at deploy time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : isError ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        ) : !templates || templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No templates.</p>
        ) : (
          templates.map((template) => (
            <div
              key={template.id}
              className="flex flex-col gap-1 rounded-md border p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Package className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-mono text-sm">{template.id}</span>
                <span className="text-sm text-muted-foreground">
                  {template.name}
                </span>
                {template.official ? (
                  <Badge variant="outline">official</Badge>
                ) : null}
                {template.dependsOn.length > 0 ? (
                  <Badge variant="neutral">
                    requires {template.dependsOn.join(", ")}
                  </Badge>
                ) : null}
                <div className="ml-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={buildSeed.isPending}
                    onClick={() =>
                      buildSeed.mutate({ seed: template.id, force: false })
                    }
                  >
                    {buildSeed.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Hammer />
                    )}
                    Build
                  </Button>
                </div>
              </div>
              <span className="text-sm text-muted-foreground">
                {template.description}
              </span>
              {template.tools.length > 0 ? (
                <span className="font-mono text-xs text-muted-foreground">
                  {template.tools.join(", ")}
                </span>
              ) : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/** Short, human status label including the error text when present. */
function statusLabel(status: ImageStatus, error?: string): string {
  if (status === "error" && error) return `error: ${error}`;
  return status;
}

function ImagesCard({ isAdmin }: { isAdmin: boolean }) {
  const {
    data: images,
    isPending,
    isError,
    error,
  } = useQuery(imagesListQuery());
  const buildSeed = useBuildSeed();
  const deleteImage = useDeleteImage();
  const [openLogs, setOpenLogs] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Images</CardTitle>
        <CardDescription>
          Built and registered base images, usable as a sandbox/prebuild{" "}
          <code>source.image</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : isError ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        ) : !images || images.length === 0 ? (
          <p className="text-sm text-muted-foreground">No images yet.</p>
        ) : (
          images.map((image) => {
            const status = image.status as ImageStatus;
            const canRebuild = image.provenance === "seed";
            const logsOpen = openLogs === image.name;
            return (
              <div
                key={image.name}
                className="flex flex-col gap-1 rounded-md border p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Boxes className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-sm">
                    {image.name}
                  </span>
                  <Badge variant="outline">
                    {PROVENANCE_LABEL[image.provenance] ?? image.provenance}
                  </Badge>
                  {status === "building" ? (
                    // Hand live build feedback to the shared, SSE-fed job
                    // component instead of the old status poll; the durable
                    // ready/error badge below owns the settled state.
                    <JobStatus kind="image-build" target={image.name} />
                  ) : (
                    <Badge variant={STATUS_VARIANT[status]}>
                      {statusLabel(status, image.error ?? undefined)}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(image.createdAt)}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOpenLogs(logsOpen ? null : image.name)}
                    >
                      {logsOpen ? <ChevronUp /> : <ChevronDown />}
                      Logs
                    </Button>
                    {isAdmin && canRebuild ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={buildSeed.isPending}
                        onClick={() =>
                          buildSeed.mutate({ seed: image.name, force: true })
                        }
                      >
                        {buildSeed.isPending ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <RefreshCw />
                        )}
                        Rebuild
                      </Button>
                    ) : null}
                    {isAdmin ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={deleteImage.isPending}
                        onClick={() => deleteImage.mutate(image.name)}
                      >
                        {deleteImage.isPending ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Trash2 />
                        )}
                        Delete
                      </Button>
                    ) : null}
                  </div>
                </div>
                {image.ref ? (
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {image.ref}
                  </span>
                ) : null}
                {logsOpen ? <ImageLogs name={image.name} /> : null}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function ImageLogs({ name }: { name: string }) {
  const { data, isPending, isError } = useQuery(imageLogsQuery(name));
  if (isPending) return <Skeleton className="h-24 w-full" />;
  if (isError)
    return <p className="text-sm text-destructive">Failed to load logs</p>;
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-muted/30 p-2 font-mono text-xs whitespace-pre-wrap">
      {data?.log || "(no output yet)"}
    </pre>
  );
}

function RegisterImageCard() {
  const registerImage = useRegisterImage();
  const [name, setName] = useState("");
  const [ref, setRef] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Register external image</CardTitle>
        <CardDescription>
          Register an already-hosted image (e.g. a GHCR ref) by reference — no
          build, used as-is.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Image name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name"
            className="w-40"
          />
          <Input
            aria-label="Image ref"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="ghcr.io/org/image:tag"
            className="flex-1"
          />
          <Button
            variant="outline"
            disabled={registerImage.isPending || !name.trim() || !ref.trim()}
            onClick={() =>
              registerImage.mutate({ name: name.trim(), ref: ref.trim() })
            }
          >
            {registerImage.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Package />
            )}
            Register
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
