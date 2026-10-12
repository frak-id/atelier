import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { orgPolicyQuery, useSetOrgPolicy } from "@/api/queries/org-policy";
import { OrgSelect } from "@/components/org-select";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { parseSpecJsonc } from "@/lib/spec";

export const Route = createFileRoute("/settings/policy")({
  component: PolicyPage,
});

function PolicyPage() {
  const [orgId, setOrgId] = useState("");

  return (
    <div className="space-y-3">
      <div className="w-full sm:max-w-xs">
        <OrgSelect id="policy-org" value={orgId} onChange={setOrgId} />
      </div>
      {orgId ? (
        <PolicyEditor orgId={orgId} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Select an organization to edit its policy.
        </p>
      )}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function PolicyEditor({ orgId }: { orgId: string }) {
  const {
    data: policy,
    isPending,
    isError,
    error,
  } = useQuery(orgPolicyQuery(orgId));
  const setPolicy = useSetOrgPolicy(orgId);
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  // Snapshot identity: reset the editor only when the persisted policy
  // actually changes (org switch or a save), never on a same-data refetch —
  // otherwise a window-focus refetch would clobber in-progress edits.
  const version =
    policy && isRecord(policy) && typeof policy.updatedAt === "string"
      ? policy.updatedAt
      : "none";
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on (orgId, version), not the policy object ref
  useEffect(() => {
    const fragment = policy && isRecord(policy) ? policy.fragment : undefined;
    setText(JSON.stringify(fragment ?? {}, null, 2));
    setErrors([]);
  }, [orgId, version]);

  function handleSave() {
    const parsed = parseSpecJsonc(text);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    if (!isRecord(parsed.value)) {
      setErrors(["Policy must be a JSON object."]);
      return;
    }
    setErrors([]);
    setPolicy.mutate(parsed.value);
  }

  if (isPending) {
    return <p className="text-sm text-muted-foreground">Loading policy…</p>;
  }

  if (isError) {
    return (
      <p className="text-sm text-destructive">
        {error instanceof Error ? error.message : "Failed to load policy"}
      </p>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Policy fragment</CardTitle>
        <CardDescription>
          Merged into every spec created in this organization.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setErrors([]);
          }}
          spellCheck={false}
          className="min-h-64 w-full rounded-md border bg-muted/30 p-3 font-mono text-xs"
        />
        {errors.length > 0 ? (
          <ul className="space-y-1 text-sm text-destructive">
            {errors.map((message, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: parse errors have no id; list resets wholesale
              <li key={index}>{message}</li>
            ))}
          </ul>
        ) : null}
        <Button disabled={setPolicy.isPending} onClick={handleSave}>
          {setPolicy.isPending ? <Loader2 className="animate-spin" /> : null}
          Save policy
        </Button>
      </CardContent>
    </Card>
  );
}
