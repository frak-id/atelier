import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { organizationsListQuery } from "@/api/queries/organizations";
import { useCaptureToolboxVersion } from "@/api/queries/toolbox-versions";
import { toolboxesListQuery } from "@/api/queries/toolboxes";
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
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Higher-level, toolbox-associated flow (docs/toolbox-versions.md §7):
 * snapshots this sandbox's tuned state into a new *version* of a toolbox the
 * caller owns, kept associated for rollback/pinning in Library → Toolboxes.
 * The server derives `paths`/`exclude` from the toolbox itself.
 */
export function SaveToolsetForToolboxSection({
  sandboxId,
}: {
  sandboxId: string;
}) {
  const { data: orgs, isPending: orgsPending } = useQuery(
    organizationsListQuery(),
  );
  // Any member of an org may capture into its toolboxes (mirrors the
  // server's `requireToolboxAccess`): the personal org first, then the rest.
  const owners = [...(orgs ?? [])]
    .sort((a, b) => Number(b.mine) - Number(a.mine))
    .map((org) => ({
      owner: `org:${org.id}`,
      label: org.mine ? "My toolboxes" : `${org.name} (org)`,
    }));
  const results = useQueries({
    queries: owners.map(({ owner }) => toolboxesListQuery(owner)),
  });
  const groups = owners
    .map(({ owner, label }, i) => ({
      owner,
      label,
      toolboxes: (results[i]?.data ?? []).filter((tb) => tb.paths.length > 0),
    }))
    .filter((group) => group.toolboxes.length > 0);
  const isLoading = orgsPending || results.some((r) => r.isPending);
  const captureVersion = useCaptureToolboxVersion();

  const [toolboxId, setToolboxId] = useState("");
  const [description, setDescription] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!toolboxId || !description) return;
    captureVersion.mutate(
      { toolboxId, sandboxId, description },
      {
        onSuccess: () => {
          setToolboxId("");
          setDescription("");
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Save toolset for toolbox</CardTitle>
        <CardDescription>
          Snapshots this sandbox's tuned state into a new version of the
          selected toolbox, kept associated with it for rollback. Saving does
          not pin it — pin the version in Library → Toolboxes to apply it to
          future spawns.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None of your toolboxes (personal or in your organizations) have{" "}
            <code>paths[]</code> configured yet (nothing to capture). Add paths
            in{" "}
            <Link to="/library/toolboxes" className="underline">
              Library → Toolboxes
            </Link>
            .
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="save-toolbox">Toolbox</Label>
              <NativeSelect
                id="save-toolbox"
                value={toolboxId}
                onChange={(e) => setToolboxId(e.target.value)}
                required
              >
                <option value="" disabled>
                  Select a toolbox…
                </option>
                {groups.map((group) => (
                  <optgroup key={group.owner} label={group.label}>
                    {group.toolboxes.map((tb) => (
                      <option key={tb.id} value={tb.id}>
                        {tb.slug}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="save-description">Description</Label>
              <Input
                id="save-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="tuned MCP config for the pi harness"
                required
              />
            </div>
            <Button type="submit" disabled={captureVersion.isPending}>
              {captureVersion.isPending ? (
                <Loader2 className="animate-spin" />
              ) : null}
              Save version
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
