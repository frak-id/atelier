import type { PrebuildRepo } from "@atelier/spec";
import { Plus, Trash2 } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** `git@host:org/repo.git` or `https://host/org/repo(.git)?` → `repo`. Best
 * effort only — the smart clonePath default, never a hard requirement (the
 * user can always type over it). */
export function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const lastSegment = trimmed.split(/[/:]/).pop() ?? "";
  return lastSegment.replace(/\.git$/i, "");
}

/**
 * The repeatable git-repo row editor shared by the prebuild editor and the
 * Launchpad starter editor: URL, branch, clone path, one row per repo.
 * `repos` is the single source of truth (from a visual edit or a JSON→visual
 * switch) — no local row state to keep in sync.
 */
export function ReposField({
  repos,
  onChange,
  urlSuggestions,
}: {
  repos: PrebuildRepo[] | undefined;
  onChange: (repos: PrebuildRepo[]) => void;
  /** Optional autocomplete for the URL field (e.g. the caller's GitHub
   * repos), rendered as a native `<datalist>` — no extra dependency. */
  urlSuggestions?: string[];
}) {
  const datalistId = useId();
  const rows = repos ?? [];

  function commit(nextRows: PrebuildRepo[]) {
    onChange(
      nextRows.map((repo) => {
        const branch = repo.branch?.trim();
        return { ...repo, branch: branch ? branch : undefined };
      }),
    );
  }

  function updateRow(index: number, patch: Partial<PrebuildRepo>) {
    commit(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function updateUrl(index: number, url: string) {
    const row = rows[index];
    if (!row) return;
    // Keep auto-filling the clone path from the repo name until the user
    // types one that diverges from the derived default — no dirty flag needed,
    // the comparison is stateless and survives every re-render.
    const shouldAutoFill = row.clonePath === repoNameFromUrl(row.url);
    updateRow(index, {
      url,
      clonePath: shouldAutoFill ? repoNameFromUrl(url) : row.clonePath,
    });
  }

  function addRow() {
    commit([...rows, { url: "", branch: "", clonePath: "" }]);
  }

  function removeRow(index: number) {
    commit(rows.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-3">
      {urlSuggestions && urlSuggestions.length > 0 ? (
        <datalist id={datalistId}>
          {urlSuggestions.map((url) => (
            <option key={url} value={url} />
          ))}
        </datalist>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No repos yet.</p>
      ) : (
        rows.map((row, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id; reordering isn't supported
            key={index}
            className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-end"
          >
            <div className="flex-1 space-y-1">
              <Label htmlFor={`repo-url-${index}`}>URL</Label>
              <Input
                id={`repo-url-${index}`}
                value={row.url}
                onChange={(e) => updateUrl(index, e.target.value)}
                placeholder="https://github.com/org/repo"
                className="font-mono"
                list={
                  urlSuggestions && urlSuggestions.length > 0
                    ? datalistId
                    : undefined
                }
              />
            </div>
            <div className="space-y-1 sm:w-32">
              <Label htmlFor={`repo-branch-${index}`}>Branch</Label>
              <Input
                id={`repo-branch-${index}`}
                value={row.branch ?? ""}
                onChange={(e) => updateRow(index, { branch: e.target.value })}
                placeholder="main"
                className="font-mono"
              />
            </div>
            <div className="space-y-1 sm:w-48">
              <Label htmlFor={`repo-clonepath-${index}`}>Clone path</Label>
              <Input
                id={`repo-clonepath-${index}`}
                value={row.clonePath}
                onChange={(e) =>
                  updateRow(index, { clonePath: e.target.value })
                }
                placeholder="repo-name"
                className="font-mono"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => removeRow(index)}
              aria-label="Remove repo"
            >
              <Trash2 />
            </Button>
          </div>
        ))
      )}
      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus />
        Add repo
      </Button>
    </div>
  );
}
