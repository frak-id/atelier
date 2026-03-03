import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { HardDrive, Loader2, Play, X } from "lucide-react";
import {
  imageBuildStatusQuery,
  imageListQuery,
  useCancelImageBuild,
  useTriggerImageBuild,
} from "@/api/queries";
import { RouteErrorComponent } from "@/components/route-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/images/")({
  component: ImagesPage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(imageListQuery(true));
  },
  pendingComponent: () => (
    <div className="p-6 space-y-6">
      <Skeleton className="h-9 w-48" />
      <div className="grid gap-4">
        {[...Array(3)].map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Static skeleton placeholders never reorder
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
    </div>
  ),
  errorComponent: RouteErrorComponent,
});

function ImagesPage() {
  const { data: images } = useSuspenseQuery(imageListQuery(true));

  if (!images) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">No images found</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">Base Images</h1>
        <p className="text-muted-foreground">
          Available development environment images
        </p>
      </div>

      <div className="grid gap-4">
        {images.map((image) => (
          <ImageCard key={image.id} image={image} />
        ))}
      </div>
    </div>
  );
}

type ImageData = {
  id: string;
  name: string;
  description: string;
  volumeSize: number;
  tools: string[];
  base: string | null;
  official?: boolean;
  available: boolean;
};

function ImageCard({ image }: { image: ImageData }) {
  const { data: buildStatus } = useQuery({
    ...imageBuildStatusQuery(image.id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "building" ? 5000 : false;
    },
  });

  const triggerBuild = useTriggerImageBuild();
  const cancelBuild = useCancelImageBuild();

  const status = buildStatus?.status ?? "idle";
  const isBuilding = status === "building";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <HardDrive className="h-5 w-5 text-muted-foreground" />
          <CardTitle>{image.name}</CardTitle>
          <Badge variant={image.available ? "success" : "secondary"}>
            {image.available ? "Available" : "Not Built"}
          </Badge>
          <BuildStatusBadge status={status} />
          <div className="ml-auto flex gap-2">
            {isBuilding ? (
              <Button
                variant="destructive"
                size="sm"
                disabled={cancelBuild.isPending}
                onClick={() => cancelBuild.mutate(image.id)}
              >
                {cancelBuild.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <X className="h-4 w-4" />
                )}
                Cancel
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={triggerBuild.isPending}
                onClick={() => triggerBuild.mutate(image.id)}
              >
                {triggerBuild.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Build
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground mb-4">{image.description}</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">ID</span>
            <p className="font-mono">{image.id}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Volume Size</span>
            <p>{image.volumeSize} GB</p>
          </div>
          <div>
            <span className="text-muted-foreground">Base Image</span>
            <p className="font-mono">{image.base ?? "none"}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Tools</span>
            <p className="truncate" title={image.tools.join(", ")}>
              {image.tools.length} installed
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {image.tools.map((tool) => (
            <Badge key={tool} variant="outline">
              {tool}
            </Badge>
          ))}
        </div>
        {status === "failed" && buildStatus?.error && (
          <div className="mt-3 rounded bg-destructive/10 p-3 text-sm text-destructive">
            <p className="font-medium">Build failed</p>
            <pre className="mt-1 whitespace-pre-wrap text-xs opacity-80">
              {buildStatus.error}
            </pre>
          </div>
        )}
        {isBuilding && buildStatus?.startedAt && (
          <p className="mt-3 text-xs text-muted-foreground">
            Started {formatRelativeTime(buildStatus.startedAt)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function BuildStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "building":
      return <Badge variant="warning">Building…</Badge>;
    case "succeeded":
      return <Badge variant="success">Built</Badge>;
    case "failed":
      return <Badge variant="error">Build Failed</Badge>;
    default:
      return null;
  }
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
