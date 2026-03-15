import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Key, Loader2 } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { unwrap } from "@/api/queries/keys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export function ApiTokenSection() {
  const { copy, isCopied } = useCopyToClipboard();
  const [token, setToken] = useState<string | null>(null);

  const generateMutation = useMutation({
    mutationKey: ["auth", "api-token"],
    mutationFn: async () => unwrap(await api.auth["api-token"].post()),
  });

  const handleGenerate = () => {
    generateMutation.mutate(undefined, {
      onSuccess: (data) => {
        if (data?.token) {
          setToken(data.token);
        }
      },
    });
  };

  const opencodeConfig = token
    ? JSON.stringify(
        {
          atelier: {
            url: window.location.origin,
            token: token,
          },
        },
        null,
        2,
      )
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">API Token</h2>
          <p className="text-sm text-muted-foreground">
            Generate a token for the OpenCode plugin or external integrations
          </p>
        </div>
        <Button onClick={handleGenerate} disabled={generateMutation.isPending}>
          {generateMutation.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Key className="h-4 w-4 mr-2" />
          )}
          Generate Token
        </Button>
      </div>

      {token && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Key className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base">Your API Token</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Token</Label>
              <div className="flex gap-2">
                <code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono flex items-center overflow-x-auto">
                  {token}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copy(token, "token")}
                >
                  {isCopied("token") ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-amber-600">
                Save this token now — it won't be shown again.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>OpenCode Plugin Config</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => copy(opencodeConfig ?? "", "config")}
                >
                  {isCopied("config") ? (
                    <span className="text-green-500 flex items-center gap-1">
                      <Check className="h-3 w-3" /> Copied
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <Copy className="h-3 w-3" /> Copy
                    </span>
                  )}
                </Button>
              </div>
              <pre className="bg-muted p-3 rounded text-xs font-mono overflow-x-auto">
                {opencodeConfig}
              </pre>
              <p className="text-xs text-muted-foreground">
                Add to your opencode.json
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
