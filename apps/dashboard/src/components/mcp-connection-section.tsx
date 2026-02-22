import { Check, Copy, Server, Shield, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { config } from "@/config";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export function McpConnectionSection() {
  const { copy, isCopied } = useCopyToClipboard();
  const { url, hasToken } = config.mcp;

  const opencodeConfig = JSON.stringify(
    {
      mcp: {
        "atelier-manager": {
          type: "remote",
          url: url,
          headers: {
            Authorization: "Bearer <your-token>",
          },
          oauth: false,
        },
      },
    },
    null,
    2,
  );

  const vscodeConfig = JSON.stringify(
    {
      mcpServers: {
        "atelier-manager": {
          url: url,
          headers: {
            Authorization: "Bearer <your-token>",
          },
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">MCP Server</h2>
          <p className="text-sm text-muted-foreground">
            Connect your IDE to the Model Context Protocol server
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base">Connection Details</CardTitle>
            </div>
            <Badge variant={hasToken ? "default" : "secondary"}>
              {hasToken ? (
                <div className="flex items-center gap-1">
                  <Shield className="h-3 w-3" />
                  Configured
                </div>
              ) : (
                <div className="flex items-center gap-1 text-amber-600">
                  <ShieldAlert className="h-3 w-3" />
                  Not Configured
                </div>
              )}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>MCP Endpoint URL</Label>
            <div className="flex gap-2">
              <code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono flex items-center">
                {url}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() => copy(url, "url")}
              >
                {isCopied("url") ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            {!hasToken && (
              <p className="text-xs text-amber-600 flex items-center gap-1 mt-1">
                <ShieldAlert className="h-3 w-3" />
                Server accepts unauthenticated requests. Set ATELIER_MCP_TOKEN
                to enable auth.
              </p>
            )}
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>OpenCode Config</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => copy(opencodeConfig, "opencode")}
                >
                  {isCopied("opencode") ? (
                    <span className="text-green-500 flex items-center gap-1">
                      <Check className="h-3 w-3" /> Copied
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <Copy className="h-3 w-3" /> Copy JSON
                    </span>
                  )}
                </Button>
              </div>
              <div className="relative">
                <pre className="bg-muted p-3 rounded text-xs font-mono overflow-x-auto h-[200px]">
                  {opencodeConfig}
                </pre>
                <p className="text-xs text-muted-foreground mt-1">
                  ~/.config/opencode/opencode.json
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Cursor / VS Code Config</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => copy(vscodeConfig, "vscode")}
                >
                  {isCopied("vscode") ? (
                    <span className="text-green-500 flex items-center gap-1">
                      <Check className="h-3 w-3" /> Copied
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <Copy className="h-3 w-3" /> Copy JSON
                    </span>
                  )}
                </Button>
              </div>
              <div className="relative">
                <pre className="bg-muted p-3 rounded text-xs font-mono overflow-x-auto h-[200px]">
                  {vscodeConfig}
                </pre>
                <p className="text-xs text-muted-foreground mt-1">
                  MCP Server settings
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
