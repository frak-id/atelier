import {
  type IntegrationConnectionInput,
  type IntegrationView,
  PERMISSION_RISKS,
  type PermissionRisk,
} from "@frak/atelier-shared";
import { Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useSaveIntegrationConnection } from "@/api/queries/integrations";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

type MinRisk = PermissionRisk;

const RISK_LABELS: Record<MinRisk, string> = {
  high: "High only",
  medium: "Medium and above",
  low: "Every prompt",
};

/** Strictest first. */
const RISK_OPTIONS = [...PERMISSION_RISKS]
  .reverse()
  .map((value) => ({ value, label: RISK_LABELS[value] }));

/** Connect or edit an integration. The stored credential is never prefilled. */
export function ConnectionDialog({
  integration,
  open,
  onOpenChange,
}: {
  integration: IntegrationView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { connection, credential, capabilities } = integration;
  const save = useSaveIntegrationConnection(integration.id);
  const [credentialValue, setCredentialValue] = useState("");
  const [clearCredential, setClearCredential] = useState(false);
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [minRisk, setMinRisk] = useState<MinRisk>(
    connection?.minRisk ?? "high",
  );
  const [delaySeconds, setDelaySeconds] = useState(
    String(connection?.delaySeconds ?? 0),
  );

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const body: IntegrationConnectionInput = { enabled };
    if (credentialValue) body.credential = credentialValue;
    else if (clearCredential) body.credential = null;
    if (capabilities.permissions) {
      body.minRisk = minRisk;
      body.delaySeconds = Math.trunc(Number(delaySeconds)) || 0;
    }
    save.mutate(body, {
      onSuccess: () => {
        setCredentialValue("");
        setClearCredential(false);
        onOpenChange(false);
      },
    });
  }

  const credentialRequired = credential?.required && !connection?.hasCredential;
  const canClear =
    connection?.hasCredential && credential && !credential.required;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {connection ? "Edit" : "Connect"} {integration.label}
            </DialogTitle>
            <DialogDescription>{integration.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {credential ? (
              <div className="space-y-1">
                <Label htmlFor={`${integration.id}-credential`}>
                  {credential.label}
                </Label>
                <Input
                  id={`${integration.id}-credential`}
                  type="password"
                  autoComplete="off"
                  value={credentialValue}
                  onChange={(e) => setCredentialValue(e.target.value)}
                  placeholder={
                    connection?.hasCredential
                      ? "Set — type to replace"
                      : undefined
                  }
                  required={credentialRequired}
                  disabled={clearCredential}
                />
                {credential.help ? (
                  <p className="text-xs text-muted-foreground">
                    {credential.help}
                  </p>
                ) : null}
                {canClear ? (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={clearCredential}
                      onChange={(e) => {
                        setClearCredential(e.target.checked);
                        if (e.target.checked) setCredentialValue("");
                      }}
                    />
                    Clear the stored credential
                  </label>
                ) : null}
              </div>
            ) : null}
            {capabilities.permissions ? (
              <>
                <div className="space-y-1">
                  <Label htmlFor={`${integration.id}-risk`}>
                    Send permission prompts
                  </Label>
                  <NativeSelect
                    id={`${integration.id}-risk`}
                    value={minRisk}
                    onChange={(e) => setMinRisk(e.target.value as MinRisk)}
                  >
                    {RISK_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${integration.id}-delay`}>
                    Wait before sending (seconds)
                  </Label>
                  <Input
                    id={`${integration.id}-delay`}
                    type="number"
                    min={0}
                    max={3600}
                    step={1}
                    value={delaySeconds}
                    onChange={(e) => setDelaySeconds(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Prompts answered in the console meanwhile are never sent.
                  </p>
                </div>
              </>
            ) : null}
            {connection && capabilities.permissions ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                Enabled
              </label>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" /> : null}
              {connection ? "Save" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
