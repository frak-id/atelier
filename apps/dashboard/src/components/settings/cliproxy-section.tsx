import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Key, Loader2, RefreshCw } from "lucide-react";
import {
  cliproxyExportQuery,
  cliproxyStatusQuery,
  cliproxyUserApiKeyQuery,
  useRefreshCliProxy,
  useToggleCliProxy,
} from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useMemo } from "react";

export function CLIProxySection() {
  const { data: status, isLoading } = useQuery(cliproxyStatusQuery);
  const { data: userApiKeyData } = useQuery(cliproxyUserApiKeyQuery);
  const { data: exportConfig } = useQuery(cliproxyExportQuery);
  const toggleMutation = useToggleCliProxy();
  const refreshMutation = useRefreshCliProxy();
  const { copy, isCopied } = useCopyToClipboard();

  const userAwareConfig = useMemo(() => {
    if (!exportConfig) return null;
    if (!userApiKeyData?.apiKey) return exportConfig;

    const config = JSON.stringify(exportConfig).replace(
      "<your-api-key>",
      userApiKeyData.apiKey,
    );
    return JSON.parse(config);
  }, [exportConfig, userApiKeyData]);

  if (isLoading) {
    return (
      <div className="border-t pt-6">
        <h2 className="text-xl font-bold mb-4">CLIProxy Auto-Config</h2>
        <div className="animate-pulse h-32 bg-muted rounded" />
      </div>
    );
  }

  const isEnabled = status?.enabled ?? false;
  const isConfigured = status?.configured ?? false;

  return (
    <div className="border-t pt-6">
      <div className="mb-4">
        <h2 className="text-xl font-bold">CLIProxy Auto-Config</h2>
        <p className="text-muted-foreground text-sm">
          Automatically configure OpenCode with models available through your
          CLIProxy instance.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-6">
          {!isConfigured && (
            <div className="rounded-md bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 p-4">
              <p className="text-sm text-yellow-800 dark:text-yellow-200">
                CLIProxy URL is not configured. Set{" "}
                <code className="font-mono text-xs bg-yellow-100 dark:bg-yellow-900 px-1 py-0.5 rounded">
                  ATELIER_CLIPROXY_URL
                </code>{" "}
                or enable CLIProxy in your Helm values.
              </p>
            </div>
          )}

          <div className="flex items-start space-x-3">
            <Checkbox
              id="cliproxy-toggle"
              checked={isEnabled}
              disabled={!isConfigured || toggleMutation.isPending}
              onChange={(e) =>
                toggleMutation.mutate((e.target as HTMLInputElement).checked)
              }
            />
            <div className="space-y-1 leading-none">
              <Label htmlFor="cliproxy-toggle" className="text-sm font-medium">
                Enable auto-configuration
              </Label>
              <p className="text-xs text-muted-foreground">
                Fetches available models from CLIProxy and registers them as an
                OpenCode provider in all sandboxes.
              </p>
            </div>
          </div>

          {isEnabled && (
            <>
              <div className="flex items-center justify-between border-t pt-4">
                <div className="flex items-center gap-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Models discovered</p>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">
                        {status?.modelCount ?? 0} models
                      </Badge>
                      {status?.lastRefresh && (
                        <span className="text-xs text-muted-foreground">
                          Last refresh:{" "}
                          {new Date(status.lastRefresh).toLocaleTimeString()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refreshMutation.mutate()}
                  disabled={refreshMutation.isPending}
                >
                  {refreshMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  Refresh
                </Button>
              </div>

              {status?.url && (
                <div className="border-t pt-4">
                  <p className="text-xs text-muted-foreground">
                    Endpoint:{" "}
                    <code className="font-mono bg-muted px-1 py-0.5 rounded">
                      {status.url}
                    </code>
                  </p>
                </div>
              )}

              <div className="border-t pt-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Key className="h-4 w-4 text-muted-foreground" />
                  <Label>Your API Key</Label>
                </div>
                {userApiKeyData?.apiKey ? (
                  <div className="flex gap-2">
                    <code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono flex items-center overflow-x-auto">
                      {userApiKeyData.apiKey}
                    </code>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => copy(userApiKeyData.apiKey!, "userApiKey")}
                    >
                      {isCopied("userApiKey") ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                ) : (
                  <div className="animate-pulse h-10 bg-muted rounded" />
                )}
              </div>

              {userAwareConfig && (
                <div className="border-t pt-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Local OpenCode Config</Label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() =>
                        copy(JSON.stringify(userAwareConfig, null, 2), "export")
                      }
                    >
                      {isCopied("export") ? (
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
                  <pre className="bg-muted p-3 rounded text-xs font-mono overflow-x-auto max-h-[300px]">
                    {JSON.stringify(userAwareConfig, null, 2)}
                  </pre>
                  <p className="text-xs text-muted-foreground">
                    Merge into{" "}
                    <code className="font-mono bg-muted px-1 py-0.5 rounded">
                      ~/.config/opencode/opencode.json
                    </code>{" "}
                    to use CLIProxy models locally.
                  </p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
