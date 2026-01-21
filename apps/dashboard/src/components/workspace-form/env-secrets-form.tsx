import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface EnvSecret {
  key: string;
  value: string;
}

export function parseEnvSecrets(secrets: Record<string, string>): EnvSecret[] {
  return Object.entries(secrets).map(([key, value]) => ({ key, value }));
}

export function serializeEnvSecrets(
  envSecrets: EnvSecret[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const { key, value } of envSecrets) {
    if (key.trim()) {
      result[key.trim()] = value;
    }
  }
  return result;
}

interface EnvSecretsFormProps {
  secrets: EnvSecret[];
  onChange: (secrets: EnvSecret[]) => void;
}

export function EnvSecretsForm({ secrets, onChange }: EnvSecretsFormProps) {
  const addSecret = () => {
    onChange([...secrets, { key: "", value: "" }]);
  };

  const removeSecret = (index: number) => {
    onChange(secrets.filter((_, i) => i !== index));
  };

  const updateSecret = (
    index: number,
    field: "key" | "value",
    value: string,
  ) => {
    onChange(
      secrets.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Environment Variables</Label>
        <Button type="button" variant="outline" size="sm" onClick={addSecret}>
          <Plus className="h-4 w-4 mr-1" />
          Add Variable
        </Button>
      </div>

      {secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No environment variables configured
        </p>
      ) : (
        <div className="space-y-2">
          {secrets.map((secret, index) => (
            <div key={`env-${index}`} className="flex gap-2">
              <Input
                placeholder="KEY"
                value={secret.key}
                onChange={(e) => updateSecret(index, "key", e.target.value)}
                className="flex-1 min-w-0 font-mono text-sm"
              />
              <Input
                type="password"
                placeholder="value"
                value={secret.value}
                onChange={(e) => updateSecret(index, "value", e.target.value)}
                className="flex-1 min-w-0"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => removeSecret(index)}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
