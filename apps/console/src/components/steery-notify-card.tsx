import {
  PERMISSION_RISKS,
  type PermissionRisk,
  type SteeryNotifyMode,
  type SteeryNotifyPolicy,
} from "@frak/atelier-shared";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  steeryNotifyQuery,
  useSetSteeryNotify,
} from "@/api/queries/steery-notify";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

const MODES: { value: SteeryNotifyMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "all", label: "Every prompt" },
  { value: "risky", label: "Risky prompts only" },
];

/** An org's Steery permission notifier: when an agent's permission prompt
 * also goes to a person's phone. */
export function SteeryNotifyCard({ orgId }: { orgId: string }) {
  const { data, isPending, isError, error } = useQuery(
    steeryNotifyQuery(orgId),
  );
  const save = useSetSteeryNotify(orgId);
  const [policy, setPolicy] = useState<SteeryNotifyPolicy | null>(null);
  const [tools, setTools] = useState("");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    if (!data) return;
    const { hasApiKey: _hasApiKey, ...stored } = data;
    setPolicy(stored);
    setTools(stored.tools.join(", "));
    setApiKey("");
  }, [data]);

  if (isPending || !policy) {
    return (
      <p className="text-sm text-muted-foreground">Loading Steery settings…</p>
    );
  }
  if (isError) {
    return <p className="text-sm text-destructive">{error.message}</p>;
  }

  const set = (patch: Partial<SteeryNotifyPolicy>) =>
    setPolicy({ ...policy, ...patch });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Steery notifications</CardTitle>
        <CardDescription>
          Also ask an agent's permission prompts on your phone with Steery. The
          first answer, here or in Steery, wins. One sandbox can override the
          mode with its <code>atelier.dev/steery-notify</code> annotation.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="steery-mode">Ask on Steery</Label>
          <NativeSelect
            id="steery-mode"
            value={policy.mode}
            onChange={(e) => set({ mode: e.target.value as SteeryNotifyMode })}
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="steery-min-risk">Lowest risk asked</Label>
          <NativeSelect
            id="steery-min-risk"
            value={policy.minRisk}
            disabled={policy.mode !== "risky"}
            onChange={(e) => set({ minRisk: e.target.value as PermissionRisk })}
          >
            {PERMISSION_RISKS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="steery-delay">Wait for the console (seconds)</Label>
          <Input
            id="steery-delay"
            type="number"
            min={0}
            max={3600}
            value={policy.delaySeconds}
            onChange={(e) =>
              set({ delaySeconds: Math.max(0, Number(e.target.value) || 0) })
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="steery-tools">Only these tools (empty: all)</Label>
          <Input
            id="steery-tools"
            placeholder="execute, edit"
            value={tools}
            onChange={(e) => setTools(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="steery-url">Steery URL</Label>
          <Input
            id="steery-url"
            value={policy.steeryUrl}
            onChange={(e) => set({ steeryUrl: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="steery-key">Steery API key</Label>
          <Input
            id="steery-key"
            type="password"
            autoComplete="off"
            placeholder={
              data.hasApiKey ? "Set (leave empty to keep)" : "Not set"
            }
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <Button
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                ...policy,
                tools: tools
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
                ...(apiKey ? { apiKey } : {}),
              })
            }
          >
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save Steery settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
