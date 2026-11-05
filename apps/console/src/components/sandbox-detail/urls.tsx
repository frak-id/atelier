import type { SandboxUrl } from "@atelier/spec";
import { ExternalLink, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusDot } from "@/components/ui/status-dot";
import { useServiceGate } from "@/hooks/use-service-gate";

/** A url is "not running" only when it declares gating processes AND the
 * server says they're not all ready — no gating info means always show as a
 * normal link (never hide, and don't guess). */
export function UrlsSection({
  sandboxId,
  urls,
}: {
  sandboxId: string;
  urls: SandboxUrl[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>URLs</CardTitle>
      </CardHeader>
      <CardContent>
        {urls.length === 0 ? (
          <p className="text-sm text-muted-foreground">No exposed URLs.</p>
        ) : (
          <ul className="space-y-1">
            {urls.map((u) => (
              <UrlRow key={u.name} sandboxId={sandboxId} url={u} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function UrlRow({ sandboxId, url }: { sandboxId: string; url: SandboxUrl }) {
  // Same gate as the ImmersiveView iframe, so a
  // URL's running/not-running state can't diverge between the two surfaces.
  const gate = useServiceGate(sandboxId, url);

  if (gate.canMount) {
    return (
      <li className="flex items-center gap-2 text-sm">
        <span className="font-medium">{url.name}</span>
        <a
          href={url.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 truncate text-muted-foreground underline"
        >
          {url.url}
          <ExternalLink className="size-3 shrink-0" />
        </a>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-2 text-sm text-muted-foreground/60">
      <StatusDot variant="neutral" />
      <span className="font-medium">{url.name}</span>
      <span className="truncate">{url.url}</span>
      <span className="shrink-0 text-xs">
        {gate.starting ? "starting…" : "service not running"}
      </span>
      <Button
        variant="ghost"
        size="sm"
        loading={gate.starting}
        onClick={() => gate.start()}
      >
        <Play />
        Start
      </Button>
    </li>
  );
}
