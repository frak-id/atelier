import type { SandboxStatus } from "@atelier/spec";
import { Maximize2, Minimize2 } from "lucide-react";
import { useState } from "react";
import { MultiTerminal } from "@/components/multi-terminal";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Expandable terminal panel embedded in the sandbox's main view. Toggles
 * between an inline height and a tall pane; the immersive view offers a
 * full-screen terminal on top of this. */
export function TerminalSection({
  sandboxId,
  status,
}: {
  sandboxId: string;
  status: SandboxStatus;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card id="terminal">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Terminal</CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
          {expanded ? "Collapse" : "Expand"}
        </Button>
      </CardHeader>
      <CardContent>
        <MultiTerminal
          sandboxId={sandboxId}
          status={status}
          className={expanded ? "h-[70vh]" : undefined}
        />
      </CardContent>
    </Card>
  );
}
