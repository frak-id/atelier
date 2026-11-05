import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Camera, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import {
  sandboxDetailQuery,
  useSnapshotSandbox,
} from "@/api/queries/sandboxes";
import { ImmersiveView } from "@/components/immersive-view";
import { SandboxActivitySection } from "@/components/sandbox-activity";
import { ExposePortSection } from "@/components/sandbox-detail/expose-port";
import { SandboxHeader } from "@/components/sandbox-detail/header";
import {
  BootedFromCard,
  MetadataSection,
} from "@/components/sandbox-detail/metadata";
import { ProcessesSection } from "@/components/sandbox-detail/processes";
import { SaveToolsetForToolboxSection } from "@/components/sandbox-detail/save-toolset";
import { TerminalSection } from "@/components/sandbox-detail/terminal";
import { UrlsSection } from "@/components/sandbox-detail/urls";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/sandboxes/$sandboxId/")({
  component: SandboxDetailPage,
});

function SandboxDetailPage() {
  const { sandboxId } = Route.useParams();
  const navigate = useNavigate();
  const {
    data: sandbox,
    isPending,
    isError,
    error,
  } = useQuery(sandboxDetailQuery(sandboxId));
  const [immersive, setImmersive] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const snapshot = useSnapshotSandbox();

  if (isPending) {
    return (
      <div className="mx-auto max-w-5xl space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (isError || !sandbox) {
    return (
      <div className="mx-auto max-w-5xl">
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle>Sandbox not found</CardTitle>
            <CardDescription>
              {error instanceof Error ? error.message : "Unknown error"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link to="/" className="text-sm underline">
              Back to sandboxes
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const hasMetadata = sandbox.annotations || sandbox.metadata;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <SandboxHeader
        sandbox={sandbox}
        onOpenTerminal={() => setImmersive(true)}
        onDestroyed={() => navigate({ to: "/" })}
      />

      {sandbox.bootedFrom ? (
        <BootedFromCard bootedFrom={sandbox.bootedFrom} />
      ) : null}
      <UrlsSection sandboxId={sandbox.id} urls={sandbox.urls} />
      <TerminalSection sandboxId={sandbox.id} />
      <ProcessesSection sandboxId={sandbox.id} processes={sandbox.processes} />
      <SandboxActivitySection sandboxId={sandbox.id} />
      <SaveToolsetForToolboxSection sandboxId={sandbox.id} />

      <div className="space-y-4">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          {moreOpen ? <ChevronDown /> : <ChevronRight />}
          More
        </Button>
        {moreOpen ? (
          <>
            {sandbox.status === "running" ? (
              <Button
                variant="outline"
                size="touch"
                loading={snapshot.isPending}
                onClick={() => snapshot.mutate(sandbox.id)}
              >
                <Camera />
                Snapshot
              </Button>
            ) : null}
            <ExposePortSection sandboxId={sandbox.id} />
            {hasMetadata ? (
              <MetadataSection
                annotations={sandbox.annotations}
                metadata={sandbox.metadata}
              />
            ) : null}
          </>
        ) : null}
      </div>

      {immersive ? (
        <ImmersiveView
          sandbox={sandbox}
          initialTab="terminal"
          onClose={() => setImmersive(false)}
        />
      ) : null}
    </div>
  );
}
