import { Cable, Check, Copy, Monitor, Terminal } from "lucide-react";
import { toast } from "sonner";
import { SSH_HOST_ALIAS } from "@/components/ssh-keys-section";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

interface QuickConnectCardProps {
  sandboxId: string;
  opencodeUrl: string;
  opencodePassword?: string;
  workspaceDir: string;
}

export function QuickConnectCard({
  sandboxId,
  opencodeUrl,
  opencodePassword,
  workspaceDir,
}: QuickConnectCardProps) {
  const { copy, isCopied } = useCopyToClipboard();
  const copyToClipboard = (text: string, id: string) => {
    copy(text, id);
    toast.success("Copied to clipboard");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Cable className="h-4 w-4" />
          Quick Connect
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <a
              href={`vscode://vscode-remote/ssh-remote+${sandboxId}@${SSH_HOST_ALIAS}${workspaceDir}`}
            >
              <Monitor className="h-4 w-4 mr-2" />
              Open in VSCode
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={`ssh://${sandboxId}@${SSH_HOST_ALIAS}`}>
              <Terminal className="h-4 w-4 mr-2" />
              SSH
            </a>
          </Button>
        </div>

        <div className="border-t" />

        <div className="space-y-2">
          <div className="text-sm font-medium">OpenCode CLI</div>
          <div className="relative">
            <code className="block bg-muted p-3 rounded-md font-mono text-xs sm:text-sm pr-10 whitespace-pre-wrap break-all">
              opencode attach {opencodeUrl}
              {opencodePassword && <> -p {opencodePassword}</>}
            </code>
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1 h-7 w-7"
              onClick={() => {
                const cmd = opencodePassword
                  ? `opencode attach ${opencodeUrl} -p ${opencodePassword}`
                  : `opencode attach ${opencodeUrl}`;
                copyToClipboard(cmd, "opencode");
              }}
            >
              {isCopied("opencode") ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">VSCode Remote</div>
          <div className="relative">
            <code className="block bg-muted p-3 rounded-md font-mono text-xs sm:text-sm pr-10 whitespace-pre-wrap break-all">
              code --remote ssh-remote+{sandboxId}@{SSH_HOST_ALIAS}{" "}
              {workspaceDir}
            </code>
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1 h-7 w-7"
              onClick={() =>
                copyToClipboard(
                  `code --remote ssh-remote+${sandboxId}@${SSH_HOST_ALIAS} ${workspaceDir}`,
                  "vscode",
                )
              }
            >
              {isCopied("vscode") ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">SSH</div>
          <div className="relative">
            <code className="block bg-muted p-3 rounded-md font-mono text-xs sm:text-sm pr-10 whitespace-pre-wrap break-all">
              ssh {sandboxId}@{SSH_HOST_ALIAS}
            </code>
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1 h-7 w-7"
              onClick={() =>
                copyToClipboard(`ssh ${sandboxId}@${SSH_HOST_ALIAS}`, "ssh")
              }
            >
              {isCopied("ssh") ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
