import type { IntegrationView } from "@frak/atelier-shared";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { useDisconnectIntegration } from "@/api/queries/integrations";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConnectionDialog } from "./connection-dialog";

/** One enabled integration: manifest, the caller's connection, its actions. */
export function IntegrationCard({
  integration,
}: {
  integration: IntegrationView;
}) {
  const { id, label, description, docsUrl, connection } = integration;
  const disconnect = useDisconnectIntegration(id);
  const [formOpen, setFormOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{label}</CardTitle>
          {connection ? (
            <Badge
              variant={
                connection.enabled || !integration.capabilities.permissions
                  ? "default"
                  : "outline"
              }
            >
              {connection.enabled || !integration.capabilities.permissions
                ? "Connected"
                : "Connected · paused"}
            </Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
          {docsUrl ? (
            <a
              href={docsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Docs <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {connection ? (
          <div className="space-y-1 text-sm text-muted-foreground">
            {integration.credential ? (
              <p>
                {integration.credential.label}:{" "}
                {connection.hasCredential ? "set" : "not set"}
              </p>
            ) : null}
            {integration.capabilities.permissions ? (
              <p>
                Permission prompts: {connection.minRisk} risk and above
                {connection.delaySeconds > 0
                  ? `, after ${connection.delaySeconds}s`
                  : ", immediately"}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setFormOpen(true)}>
            {connection ? "Edit" : "Connect"}
          </Button>
          {connection ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disconnect.isPending}
              onClick={() => setDisconnectOpen(true)}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      </CardContent>
      {/* Mounted only while open, so every open starts from the saved state. */}
      {formOpen ? (
        <ConnectionDialog
          integration={integration}
          open
          onOpenChange={setFormOpen}
        />
      ) : null}
      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title={`Disconnect ${label}?`}
        description="Its stored credential is deleted."
        confirmLabel="Disconnect"
        onConfirm={() => disconnect.mutate()}
      />
    </Card>
  );
}
