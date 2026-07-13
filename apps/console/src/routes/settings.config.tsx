import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { serverConfigQuery, useSetConfig } from "@/api/queries/server-config";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/settings/config")({
  component: ConfigPage,
});

type ConfigEntry = {
  key: string;
  label: string;
  description: string;
  type: "boolean" | "number";
  value: boolean | number;
  default: boolean | number;
  isDefault: boolean;
  updatedAt: string | null;
};

function ConfigPage() {
  const { data, isPending, isError, error } = useQuery(serverConfigQuery());

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Server configuration</h2>
        <p className="text-sm text-muted-foreground">
          Runtime knobs for this server. Changes apply live.
        </p>
      </div>
      {isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
      ) : (
        <div className="space-y-2">
          {(data as ConfigEntry[]).map((entry) => (
            <ConfigRow key={entry.key} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigRow({ entry }: { entry: ConfigEntry }) {
  const setConfig = useSetConfig();

  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 p-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{entry.label}</span>
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-muted-foreground">
              {entry.key}
            </code>
            {entry.isDefault ? (
              <span className="text-[11px] text-muted-foreground">default</span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{entry.description}</p>
        </div>
        <div className="shrink-0">
          {entry.type === "boolean" ? (
            <label
              htmlFor={`config-${entry.key}`}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <Checkbox
                id={`config-${entry.key}`}
                checked={entry.value === true}
                disabled={setConfig.isPending}
                onChange={(e) =>
                  setConfig.mutate({ key: entry.key, value: e.target.checked })
                }
              />
              {entry.value ? "Enabled" : "Disabled"}
            </label>
          ) : (
            <NumberEditor
              value={entry.value as number}
              pending={setConfig.isPending}
              onSave={(value) => setConfig.mutate({ key: entry.key, value })}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function NumberEditor({
  value,
  pending,
  onSave,
}: {
  value: number;
  pending: boolean;
  onSave: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const parsed = Number(draft);
  const valid = Number.isInteger(parsed) && parsed >= 0;
  const dirty = draft !== String(value);

  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min={0}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="w-20"
      />
      <Button
        size="sm"
        disabled={pending || !valid || !dirty}
        onClick={() => onSave(parsed)}
      >
        {pending ? <Loader2 className="animate-spin" /> : null}
        Save
      </Button>
    </div>
  );
}
