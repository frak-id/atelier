import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { HardDrive } from "lucide-react";
import { imageListQuery } from "@/api/queries";
import { Badge } from "@/components/ui/badge";
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
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
    </div>
  ),
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
          <Card key={image.id}>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center gap-2">
                <HardDrive className="h-5 w-5 text-muted-foreground" />
                <CardTitle>{image.name}</CardTitle>
                <Badge variant={image.available ? "success" : "secondary"}>
                  {image.available ? "Available" : "Not Built"}
                </Badge>
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
                  <span className="text-muted-foreground">Volume Name</span>
                  <p className="font-mono">{image.volumeName}</p>
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
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
