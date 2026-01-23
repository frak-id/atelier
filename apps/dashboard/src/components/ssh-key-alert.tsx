import { Link } from "@tanstack/react-router";
import { AlertTriangle, XCircle } from "lucide-react";
import type { SshKey } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getSshKeyExpirationStatus } from "@/lib/utils";

type SshKeyAlertType = "no_keys" | "expired" | "expiring_soon";

interface SshKeyAlertProps {
  keys: SshKey[] | null | undefined;
}

function getAlertInfo(keys: SshKey[] | null | undefined): {
  type: SshKeyAlertType;
  daysRemaining?: number;
} | null {
  if (!keys || keys.length === 0) {
    return { type: "no_keys" };
  }

  let soonestExpiring: { daysRemaining: number } | null = null;
  let hasValidKey = false;

  for (const key of keys) {
    const status = getSshKeyExpirationStatus(key.expiresAt);

    if (status.status === "valid" || status.status === "no_expiration") {
      hasValidKey = true;
    }

    if (status.status === "expiring_soon") {
      if (
        !soonestExpiring ||
        status.daysRemaining < soonestExpiring.daysRemaining
      ) {
        soonestExpiring = { daysRemaining: status.daysRemaining };
      }
      hasValidKey = true;
    }
  }

  if (!hasValidKey) {
    return { type: "expired" };
  }

  if (soonestExpiring) {
    return {
      type: "expiring_soon",
      daysRemaining: soonestExpiring.daysRemaining,
    };
  }

  return null;
}

export function SshKeyAlert({ keys }: SshKeyAlertProps) {
  const alertInfo = getAlertInfo(keys);

  if (!alertInfo) {
    return null;
  }

  const { type, daysRemaining } = alertInfo;

  if (type === "no_keys") {
    return (
      <Card className="border-amber-500/50 bg-amber-500/10">
        <CardContent className="flex items-center gap-3 py-4">
          <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium">SSH keys not configured</p>
            <p className="text-sm text-muted-foreground">
              You won't be able to SSH into sandboxes until you configure your
              SSH keys.
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/settings">Configure SSH Keys</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (type === "expired") {
    return (
      <Card className="border-destructive/50 bg-destructive/10">
        <CardContent className="flex items-center gap-3 py-4">
          <XCircle className="h-5 w-5 text-destructive shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-destructive">
              All SSH keys expired
            </p>
            <p className="text-sm text-muted-foreground">
              Your SSH keys have expired. Generate a new key to connect to your
              sandboxes.
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/settings">Regenerate SSH Key</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (type === "expiring_soon") {
    const dayText = daysRemaining === 1 ? "day" : "days";
    return (
      <Card className="border-amber-500/50 bg-amber-500/10">
        <CardContent className="flex items-center gap-3 py-4">
          <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium">
              SSH key expiring in {daysRemaining} {dayText}
            </p>
            <p className="text-sm text-muted-foreground">
              Your SSH key will expire soon. Regenerate it to maintain access to
              your sandboxes.
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/settings">Regenerate SSH Key</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return null;
}
