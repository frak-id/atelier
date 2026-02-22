import { Link } from "@tanstack/react-router";
import { Globe, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useStartBrowser, useStopBrowser } from "@/api/queries";
import { Button } from "@/components/ui/button";

export function BrowserButton({
  sandboxId,
  browserStatus,
}: {
  sandboxId: string;
  browserStatus?: { status: string; url?: string };
}) {
  const startBrowser = useStartBrowser(sandboxId);
  const stopBrowser = useStopBrowser(sandboxId);
  const pendingOpenRef = useRef(false);

  const browserVncUrl = browserStatus?.url
    ? `${browserStatus.url}/?autoconnect=true&resize=remote`
    : undefined;

  useEffect(() => {
    if (
      pendingOpenRef.current &&
      browserStatus?.status === "running" &&
      browserVncUrl
    ) {
      pendingOpenRef.current = false;
      window.open(`/sandboxes/${sandboxId}?tab1=web`, "_blank");
    }
  }, [browserStatus?.status, browserVncUrl, sandboxId]);

  if (browserStatus?.status === "running" && browserVncUrl) {
    return (
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" asChild>
          <Link
            to="/sandboxes/$id"
            params={{ id: sandboxId }}
            search={{ tab1: "web" }}
            target="_blank"
          >
            <Globe className="h-4 w-4 mr-2" />
            Browser
          </Link>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => stopBrowser.mutate()}
          disabled={stopBrowser.isPending}
          className="h-8 px-2 text-muted-foreground hover:text-destructive"
        >
          {stopBrowser.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <span className="text-xs">Stop</span>
          )}
        </Button>
      </div>
    );
  }

  const handleStart = () => {
    pendingOpenRef.current = true;
    startBrowser.mutate();
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleStart}
      disabled={startBrowser.isPending || browserStatus?.status === "starting"}
    >
      {startBrowser.isPending || browserStatus?.status === "starting" ? (
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
      ) : (
        <Globe className="h-4 w-4 mr-2" />
      )}
      {browserStatus?.status === "starting" ? "Starting..." : "Browser"}
    </Button>
  );
}
