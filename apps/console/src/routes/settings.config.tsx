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
  type: "boolean" | "number" | "string";
  options?: readonly string[];
  value: boolean | number | string;
  default: boolean | number | string;
  isDefault: boolean;
  locked: boolean;
  envVar: string;
  updatedAt: string | null;
};

function ConfigPage() {
  const { data, isPending, isError, error } = useQuery(serverConfigQuery());

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Server configuration</h2>
        <p className="text-sm text-muted-foreground">
          Runtime knobs for this server. Changes apply live. Keys set via an
          environment variable are locked and shown read-only.
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
            {entry.locked ? (
              <span
                className="text-[11px] text-amber-600"
                title={`Locked by ${entry.envVar}`}
              >
                locked by env
              </span>
            ) : entry.isDefault ? (
              <span className="text-[11px] text-muted-foreground">default</span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{entry.description}</p>
          {entry.locked ? (
            <p className="text-[11px] text-muted-foreground">
              Set by <code className="font-mono">{entry.envVar}</code>. Unset it
              to edit here.
            </p>
          ) : null}
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
                disabled={setConfig.isPending || entry.locked}
                onChange={(e) =>
                  setConfig.mutate({ key: entry.key, value: e.target.checked })
                }
              />
              {entry.value ? "Enabled" : "Disabled"}
            </label>
          ) : entry.type === "number" ? (
            <NumberEditor
              value={entry.value as number}
              pending={setConfig.isPending}
              locked={entry.locked}
              onSave={(value) => setConfig.mutate({ key: entry.key, value })}
            />
          ) : entry.options ? (
            <EnumEditor
              value={String(entry.value)}
              options={entry.options}
              pending={setConfig.isPending}
              locked={entry.locked}
              onSave={(value) => setConfig.mutate({ key: entry.key, value })}
            />
          ) : (
            <StringEditor
              value={String(entry.value)}
              pending={setConfig.isPending}
              locked={entry.locked}
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
  locked,
  onSave,
}: {
  value: number;
  pending: boolean;
  locked: boolean;
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
        disabled={locked}
        onChange={(e) => setDraft(e.target.value)}
        className="w-20"
      />
      <Button
        size="sm"
        disabled={pending || locked || !valid || !dirty}
        onClick={() => onSave(parsed)}
      >
        {pending ? <Loader2 className="animate-spin" /> : null}
        Save
      </Button>
    </div>
  );
}

function StringEditor({
  value,
  pending,
  locked,
  onSave,
}: {
  value: string;
  pending: boolean;
  locked: boolean;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const dirty = draft !== value;

  return (
    <div className="flex items-center gap-2">
      <Input
        type="text"
        value={draft}
        disabled={locked}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="w-64 font-mono text-xs"
      />
      <Button
        size="sm"
        disabled={pending || locked || !dirty}
        onClick={() => onSave(draft.trim())}
      >
        {pending ? <Loader2 className="animate-spin" /> : null}
        Save
      </Button>
    </div>
  );
}

function EnumEditor({
  value,
  options,
  pending,
  locked,
  onSave,
}: {
  value: string;
  options: readonly string[];
  pending: boolean;
  locked: boolean;
  onSave: (value: string) => void;
}) {
  return (
    <select
      value={value}
      disabled={pending || locked}
      onChange={(e) => onSave(e.target.value)}
      className="h-9 rounded-md border bg-background px-2 text-sm"
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}
