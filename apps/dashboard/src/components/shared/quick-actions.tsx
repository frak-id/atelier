import { Code, ExternalLink, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface QuickActionsProps {
  vscodeUrl?: string;
  sshCommand?: string;
  terminalUrl?: string;
  opencodeUrl?: string;
  size?: "sm" | "default";
  showLabels?: boolean;
}

export function QuickActions({
  vscodeUrl,
  sshCommand,
  terminalUrl,
  opencodeUrl,
  size = "sm",
  showLabels = false,
}: QuickActionsProps) {
  const buttonSize = size === "sm" ? "h-7 w-7" : "h-9 w-9";
  const iconSize = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";

  const handleCopySsh = () => {
    if (sshCommand) {
      navigator.clipboard.writeText(sshCommand);
    }
  };

  return (
    <div className="flex items-center gap-1">
      {vscodeUrl && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={buttonSize}
              onClick={() => window.open(vscodeUrl, "_blank")}
            >
              <Code className={iconSize} />
              {showLabels && <span className="ml-1 text-xs">VSCode</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open in VSCode</TooltipContent>
        </Tooltip>
      )}

      {sshCommand && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={buttonSize}
              onClick={handleCopySsh}
            >
              <Terminal className={iconSize} />
              {showLabels && <span className="ml-1 text-xs">SSH</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy SSH command</TooltipContent>
        </Tooltip>
      )}

      {terminalUrl && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={buttonSize}
              onClick={() => window.open(terminalUrl, "_blank")}
            >
              <Terminal className={iconSize} />
              {showLabels && <span className="ml-1 text-xs">Terminal</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open Terminal</TooltipContent>
        </Tooltip>
      )}

      {opencodeUrl && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={buttonSize}
              onClick={() => window.open(opencodeUrl, "_blank")}
            >
              <ExternalLink className={iconSize} />
              {showLabels && <span className="ml-1 text-xs">OpenCode</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open in OpenCode</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
