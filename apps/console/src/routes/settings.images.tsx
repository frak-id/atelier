import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Boxes,
  ChevronDown,
  ChevronUp,
  FileArchive,
  Hammer,
  Loader2,
  Package,
  RefreshCw,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import {
  imageLogsQuery,
  imagesListQuery,
  imageTemplatesQuery,
  useBuildDockerfile,
  useBuildSeed,
  useDeleteImage,
  useRegisterImage,
  useUploadImage,
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
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/formatters";

export const Route = createFileRoute("/settings/images")({
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
  return (
    <div className="space-y-3">
      <TemplatesCard />
      <ImagesCard />
      <BringYourOwnCard />
      <UploadZipCard />
    </div>
  );
}

/** Human-readable byte size for the selected-file chip. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Build from an uploaded zip build context (Dockerfile + accompanying
 * files). A drag-and-drop dropzone over a hidden file input — the "nice
 * file picker" beside the pasted-Dockerfile path. */
function UploadZipCard() {
  const upload = useUploadImage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);

  function pick(selected: File | undefined) {
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith(".zip")) return;
    setFile(selected);
    // Default the image name to the zip's basename the first time.
    if (!name.trim()) {
      const base = selected.name.replace(/\.zip$/i, "").toLowerCase();
      setName(base.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""));
    }
  }

  function onDrop(e: DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    setDragOver(false);
    pick(e.dataTransfer.files[0]);
  }

  function submit() {
    if (!file || !name.trim()) return;
    upload.mutate(
      { name: name.trim(), file },
      {
        onSuccess: () => {
          setFile(null);
          if (inputRef.current) inputRef.current.value = "";
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload a build context</CardTitle>
        <CardDescription>
          A <code>.zip</code> containing a <code>Dockerfile</code> at its root
          plus any files it <code>COPY</code>s. Built in your cluster and pushed
          to your registry.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="zip-name">Image name</Label>
          <Input
            id="zip-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-custom-image"
          />
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        {file ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-3">
            <FileArchive className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-sm">{file.name}</span>
            <span className="text-xs text-muted-foreground">
              {formatBytes(file.size)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => {
                setFile(null);
                if (inputRef.current) inputRef.current.value = "";
              }}
            >
              <X />
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`flex w-full flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center transition-colors ${
              dragOver
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/25 hover:border-muted-foreground/50"
            }`}
          >
            <UploadCloud className="size-6 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Drag a <code>.zip</code> here, or click to browse
            </span>
          </button>
        )}
        <Button
          disabled={upload.isPending || !file || !name.trim()}
          onClick={submit}
        >
          {upload.isPending ? <Loader2 className="animate-spin" /> : <Hammer />}
          Build from zip
        </Button>
      </CardContent>
    </Card>
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

function ImagesCard() {
  const {
    data: images,
    isPending,
    isError,
    error,
  } = useQuery(imagesListQuery());
  const buildSeed = useBuildSeed();
  const buildDockerfile = useBuildDockerfile();
  const deleteImage = useDeleteImage();
  const [openLogs, setOpenLogs] = useState<string | null>(null);

  function rebuild(image: {
    name: string;
    provenance: string;
    dockerfile?: string;
  }) {
    if (image.provenance === "seed") {
      buildSeed.mutate({ seed: image.name, force: true });
    } else if (image.provenance === "dockerfile" && image.dockerfile) {
      buildDockerfile.mutate({
        name: image.name,
        dockerfile: image.dockerfile,
      });
    }
  }

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
            const canRebuild =
              image.provenance === "seed" ||
              (image.provenance === "dockerfile" && image.dockerfile);
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
                    {canRebuild ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          buildSeed.isPending || buildDockerfile.isPending
                        }
                        onClick={() => rebuild(image)}
                      >
                        {buildSeed.isPending || buildDockerfile.isPending ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <RefreshCw />
                        )}
                        Rebuild
                      </Button>
                    ) : null}
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

const DOCKERFILE_PLACEHOLDER = `FROM node:22-slim
RUN apt-get update && apt-get install -y curl`;

function BringYourOwnCard() {
  const buildDockerfile = useBuildDockerfile();
  const registerImage = useRegisterImage();

  const [name, setName] = useState("");
  const [dockerfile, setDockerfile] = useState("");

  const [regName, setRegName] = useState("");
  const [regRef, setRegRef] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bring your own</CardTitle>
        <CardDescription>
          Build from a pasted Dockerfile, or register an already-hosted image
          (e.g. a GHCR ref) by reference — no build, used as-is.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="image-name">Image name</Label>
          <Input
            id="image-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-custom-image"
          />
          <textarea
            value={dockerfile}
            onChange={(e) => setDockerfile(e.target.value)}
            spellCheck={false}
            placeholder={DOCKERFILE_PLACEHOLDER}
            className="min-h-40 w-full rounded-md border bg-muted/30 p-2 font-mono text-xs"
          />
          <Button
            disabled={
              buildDockerfile.isPending || !name.trim() || !dockerfile.trim()
            }
            onClick={() =>
              buildDockerfile.mutate({ name: name.trim(), dockerfile })
            }
          >
            {buildDockerfile.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Hammer />
            )}
            Build from Dockerfile
          </Button>
        </div>
        <div className="space-y-2 border-t pt-4">
          <Label htmlFor="register-name">Register external image</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="register-name"
              value={regName}
              onChange={(e) => setRegName(e.target.value)}
              placeholder="name"
              className="w-40"
            />
            <Input
              value={regRef}
              onChange={(e) => setRegRef(e.target.value)}
              placeholder="ghcr.io/org/image:tag"
              className="flex-1"
            />
            <Button
              variant="outline"
              disabled={
                registerImage.isPending || !regName.trim() || !regRef.trim()
              }
              onClick={() =>
                registerImage.mutate({
                  name: regName.trim(),
                  ref: regRef.trim(),
                })
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
        </div>
      </CardContent>
    </Card>
  );
}
