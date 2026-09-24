import {
  buildRepoPrebuildSpec,
  findRepoBranchPrebuild,
  normalizeBranch,
  repoCloneName,
} from "@atelier/spec";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Hammer, Info } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { imagesListQuery } from "@/api/queries/images";
import { useRunPrebuild } from "@/api/queries/prebuilds";
import { JobStatusBadge } from "@/components/job-status";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  type RepoCatalogEntry,
  useDefaultImage,
  useRepoInspection,
} from "@/hooks/use-repo-catalog";
import { formatRelativeTime, repoBranchLabel } from "@/lib/formatters";
import { activeJobForBranch } from "@/lib/repo-catalog";
import { RepoIdentity } from "./repo-identity";

const OTHER_BRANCH = "\0other";

/**
 * The "Customize" path next to the one-click create: the same spec
 * (`buildRepoPrebuildSpec`), with branch, base image, clone path and setup
 * steps exposed. Everything is prefilled (branches + detected steps from
 * the GitHub inspection), so Enter alone reproduces the one-click result.
 */
export function QuickPrebuildDialog({
  repoName,
  entry,
  onOpenChange,
}: {
  /** `owner/name` being customized; `undefined` closes the dialog. */
  repoName: string | undefined;
  /** Its live catalog entry. Missing while open = the repo left the list
   * (access revoked, refreshed away): say so instead of vanishing. */
  entry: RepoCatalogEntry | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const close = () => onOpenChange(false);
  return (
    <Dialog open={repoName !== undefined} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        {entry ? (
          // Keyed so a different repo always starts from a fresh form.
          <QuickPrebuildForm
            key={entry.repo.fullName}
            entry={entry}
            onDone={close}
          />
        ) : repoName ? (
          <RepoGone repoName={repoName} onClose={close} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RepoGone({
  repoName,
  onClose,
}: {
  repoName: string;
  onClose: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-warning" />
          Repository no longer available
        </DialogTitle>
        <DialogDescription>
          <span className="font-mono">{repoName}</span> isn't in your GitHub
          repository list anymore. Your access may have changed. Anything
          already prebuilt stays under Stored prebuilds.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button onClick={onClose}>Close</Button>
      </DialogFooter>
    </>
  );
}

function QuickPrebuildForm({
  entry,
  onDone,
}: {
  entry: RepoCatalogEntry;
  onDone: () => void;
}) {
  const { repo } = entry;
  const ids = useId();
  const defaultImage = useDefaultImage();
  const runPrebuild = useRunPrebuild();

  const [branchChoice, setBranchChoice] = useState(repo.defaultBranch);
  const [customBranch, setCustomBranch] = useState("");
  const [image, setImage] = useState<string | undefined>();
  const [clonePath, setClonePath] = useState(repoCloneName(repo.cloneUrl));
  // Steps follow the detected suggestion for the chosen branch until the
  // user edits them; after that their text wins.
  const [stepsText, setStepsText] = useState<string | undefined>();

  const branch =
    branchChoice === OTHER_BRANCH ? customBranch.trim() : branchChoice;
  const refParam = normalizeBranch(branch, repo.defaultBranch);

  const inspection = useRepoInspection(repo, refParam, {
    // A half-typed custom branch would 404 on every keystroke.
    enabled: branchChoice !== OTHER_BRANCH || branch.length > 0,
  });
  const images = useQuery(imagesListQuery());

  const { branches, suggestedBuild: suggested } = inspection;
  const steps = stepsText ?? suggested?.join("\n") ?? "";
  // Until the user types their own steps, the spec depends on detection:
  // submitting early would bake a step-less prebuild with a different hash.
  const detecting = stepsText === undefined && inspection.detecting;

  const readyImages = (images.data ?? [])
    .filter((i) => i.status === "ready")
    .map((i) => i.name);
  const imageOptions = [...new Set([defaultImage, ...readyImages])];
  const chosenImage = image ?? defaultImage;

  const existing = findRepoBranchPrebuild(
    entry.prebuilds,
    repo.cloneUrl,
    refParam,
    repo.defaultBranch,
  );
  const buildingJob = activeJobForBranch(entry, refParam);
  const canSubmit =
    !runPrebuild.isPending &&
    !buildingJob &&
    !detecting &&
    branch.length > 0 &&
    clonePath.trim().length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    const spec = buildRepoPrebuildSpec({
      repo: repo.cloneUrl,
      branch: refParam,
      image: chosenImage,
      clonePath,
      build: steps.split("\n"),
    });
    runPrebuild.mutate(
      {
        spec,
        force: existing !== undefined,
        label: repoBranchLabel(repo.fullName, refParam),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New prebuild</DialogTitle>
        <DialogDescription>
          Clone the repo, run the setup steps, and snapshot the result, so every
          sandbox of it boots ready to work.
        </DialogDescription>
      </DialogHeader>

      <RepoIdentity repo={repo} className="rounded-md border bg-muted/20 p-3" />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${ids}-branch`}>Branch</Label>
          <NativeSelect
            id={`${ids}-branch`}
            value={branchChoice}
            onChange={(e) => setBranchChoice(e.target.value)}
          >
            {branches.map((b) => (
              <option key={b} value={b}>
                {b === repo.defaultBranch ? `${b} (default)` : b}
              </option>
            ))}
            <option value={OTHER_BRANCH}>Other branch…</option>
          </NativeSelect>
          {branchChoice === OTHER_BRANCH ? (
            <Input
              aria-label="Branch name"
              value={customBranch}
              onChange={(e) => setCustomBranch(e.target.value)}
              placeholder="feature/my-branch"
              className="mt-1.5 font-mono"
              autoFocus
            />
          ) : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-image`}>Base image</Label>
          <NativeSelect
            id={`${ids}-image`}
            value={chosenImage}
            onChange={(e) => setImage(e.target.value)}
          >
            {imageOptions.map((name) => (
              <option key={name} value={name}>
                {name === defaultImage ? `${name} (default)` : name}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${ids}-path`}>Clone path</Label>
        <Input
          id={`${ids}-path`}
          value={clonePath}
          onChange={(e) => setClonePath(e.target.value)}
          className="font-mono"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor={`${ids}-steps`}>Setup steps</Label>
          <span className="text-xs text-muted-foreground">
            {detecting
              ? "Detecting from the repo…"
              : stepsText === undefined && suggested
                ? suggested.length > 0
                  ? "Detected from lockfiles"
                  : "Nothing detected"
                : "One per line, run inside the repo"}
          </span>
        </div>
        {detecting && !suggested ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <textarea
            id={`${ids}-steps`}
            value={steps}
            onChange={(e) => setStepsText(e.target.value)}
            spellCheck={false}
            rows={4}
            placeholder="bun install"
            className="w-full rounded-md border bg-muted/30 p-2 font-mono text-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            onKeyDown={(e) => {
              // Enter adds a line here; Cmd/Ctrl+Enter submits the form.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
            }}
          />
        )}
      </div>

      {existing ? (
        <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
          <Info className="mt-px size-3.5 shrink-0" />
          This branch already has a prebuild (built{" "}
          {formatRelativeTime(existing.createdAt)}). Creating it again rebuilds
          it from scratch.
        </p>
      ) : null}

      {buildingJob ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <JobStatusBadge job={buildingJob} />
          This branch is building right now. You can rebuild it once it
          finishes.
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!canSubmit}
          loading={runPrebuild.isPending}
          title={
            buildingJob
              ? "This branch is already building"
              : detecting
                ? "Detecting setup steps…"
                : undefined
          }
        >
          {runPrebuild.isPending ? null : <Hammer />}
          {existing ? "Rebuild prebuild" : "Create prebuild"}
        </Button>
      </DialogFooter>
    </form>
  );
}
