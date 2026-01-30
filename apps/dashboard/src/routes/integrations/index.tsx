import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle, Loader2, Save, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import {
  githubStatusQuery,
  slackConfigQuery,
  slackStatusQuery,
  useDeleteSlackConfig,
  useUpdateSlackConfig,
} from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/integrations/")({
  component: IntegrationsPage,
});

function IntegrationsPage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Integrations</h1>
        <p className="text-muted-foreground">
          Manage external service connections
        </p>
      </div>

      <SlackSection />
      <GitHubSection />
    </div>
  );
}

function SlackSection() {
  const { data: status, isLoading: loadingStatus } = useQuery(slackStatusQuery);
  const { data: config, isLoading: loadingConfig } = useQuery(slackConfigQuery);
  const updateMutation = useUpdateSlackConfig();
  const deleteMutation = useDeleteSlackConfig();

  const [editing, setEditing] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");

  const handleSave = () => {
    updateMutation.mutate(
      { botToken, appToken, signingSecret },
      {
        onSuccess: () => {
          setEditing(false);
          setBotToken("");
          setAppToken("");
          setSigningSecret("");
        },
      },
    );
  };

  const handleDelete = () => {
    if (!confirm("Remove Slack configuration? The bot will disconnect."))
      return;
    deleteMutation.mutate(undefined, {
      onSuccess: () => setEditing(false),
    });
  };

  if (loadingStatus || loadingConfig) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Slack</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse h-32 bg-muted rounded" />
        </CardContent>
      </Card>
    );
  }

  const hasConfig = config && (config.botToken || config.appToken);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Slack</CardTitle>
          <div className="flex items-center gap-2">
            {status?.connected ? (
              <Badge className="bg-green-500/10 text-green-600 border-green-500/20">
                <CheckCircle className="h-3 w-3 mr-1" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary">
                <XCircle className="h-3 w-3 mr-1" />
                Disconnected
              </Badge>
            )}
            {status?.activeThreads !== undefined &&
              status.activeThreads > 0 && (
                <Badge variant="outline">
                  {status.activeThreads} active thread
                  {status.activeThreads !== 1 ? "s" : ""}
                </Badge>
              )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {editing ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Bot Token</Label>
              <Input
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="xoxb-..."
                type="password"
              />
            </div>
            <div className="space-y-2">
              <Label>App Token</Label>
              <Input
                value={appToken}
                onChange={(e) => setAppToken(e.target.value)}
                placeholder="xapp-..."
                type="password"
              />
            </div>
            <div className="space-y-2">
              <Label>Signing Secret</Label>
              <Input
                value={signingSecret}
                onChange={(e) => setSigningSecret(e.target.value)}
                placeholder="Enter signing secret"
                type="password"
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={handleSave}
                disabled={
                  updateMutation.isPending ||
                  !botToken ||
                  !appToken ||
                  !signingSecret
                }
              >
                {updateMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                Save
              </Button>
              <Button variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {hasConfig ? (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Bot Token</span>
                  <span className="font-mono">{config.botToken}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">App Token</span>
                  <span className="font-mono">{config.appToken}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Signing Secret</span>
                  <span className="font-mono">{config.signingSecret}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No Slack configuration. Add your bot credentials to enable the
                @sandbox integration.
              </p>
            )}
            <div className="flex gap-2">
              <Button onClick={() => setEditing(true)}>
                {hasConfig ? "Update Config" : "Configure Slack"}
              </Button>
              {hasConfig && (
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Remove
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GitHubSection() {
  const { data: status, isLoading } = useQuery(githubStatusQuery);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse h-16 bg-muted rounded" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">GitHub</CardTitle>
          {status?.connected ? (
            <Badge className="bg-green-500/10 text-green-600 border-green-500/20">
              <CheckCircle className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          ) : (
            <Badge variant="secondary">
              <XCircle className="h-3 w-3 mr-1" />
              Not Connected
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {status?.connected ? (
          <p className="text-sm text-muted-foreground">
            GitHub App installed. Manage settings in the Settings page.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Connect GitHub via the Settings page to enable repository access.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
