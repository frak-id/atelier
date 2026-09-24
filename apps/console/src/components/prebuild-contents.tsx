import {
  gatingProcessNames,
  type PortEntry,
  type PrebuildRecord,
  type PrebuildRepo,
  type ProcessEntry,
  prebuildRepos,
  repoKey,
  repoShortName,
} from "@atelier/spec";
import { ExternalLink, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { GithubIcon } from "@/components/ui/github-icon";
import { countLabel, prebuildRepoLabel } from "@/lib/formatters";
import { cn } from "@/lib/utils";

/** `https://github.com/owner/name` when `url` clones a github.com repo
 * (https, scp-style or `ssh://`), else `undefined`. Compares hosts through
 * `repoKey` so every clone-URL spelling still resolves to the same link. */
function githubHtmlUrl(url: string): string | undefined {
  const key = repoKey(url);
  if (!key.startsWith("github.com/")) return undefined;
  return `https://${key}`;
}

/** One repo chip: `owner/name[#branch]`, the clone path in a tooltip, and a
 * link out when it's a github.com repo. */
function RepoChip({ repo }: { repo: PrebuildRepo }) {
  const label = prebuildRepoLabel(repo);
  const htmlUrl = githubHtmlUrl(repo.url);
  const title = `Cloned into ${repo.clonePath}`;
  return (
    <Badge variant="outline" title={title} className="gap-1 font-normal">
      <GithubIcon className="size-3 shrink-0 text-muted-foreground" />
      <span className="font-mono">{label}</span>
      {htmlUrl ? (
        <a
          href={htmlUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          aria-label={`Open ${repoShortName(repo.url)} on GitHub`}
          className="text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3" />
        </a>
      ) : null}
    </Badge>
  );
}

/** A port a sandbox booted from the prebuild serves (its dev server), with
 * the commands behind it (`gatingProcessNames`, the runtime's own rule) in
 * the tooltip. */
function PortChip({
  port,
  processes = [],
}: {
  port: PortEntry;
  processes?: ProcessEntry[];
}) {
  const gating = gatingProcessNames(port, processes);
  const gates = processes.filter((p) => gating.includes(p.name));
  return (
    <Badge
      variant="outline"
      className="gap-1 font-normal"
      title={
        gates.length > 0
          ? gates
              .map(
                (p) => `${p.command}${p.lazy ? " (starts on first open)" : ""}`,
              )
              .join("\n")
          : `Port ${port.port}`
      }
    >
      <Play className="size-2.5 shrink-0 fill-current text-success" />
      <span className="font-mono">
        {port.name}:{port.port}
      </span>
    </Badge>
  );
}

/**
 * What a prebuild contains, read from `record.spec` only — never from the
 * opaque `metadata` (see `packages/spec/src/repo-prebuild.ts`): every repo
 * it clones (owner/name, branch, clone path), the ports it serves (its dev
 * servers), its base image and its number of setup steps.
 *
 * A spec-less record (hand-made, or from before specs were stored) reads as
 * its ref alone. Chips wrap, so this stays readable with one repo or five.
 */
export function PrebuildContents({
  prebuild,
  className,
}: {
  prebuild: PrebuildRecord;
  className?: string;
}) {
  const spec = prebuild.spec;
  if (!spec) {
    return (
      <span
        className={cn("font-mono text-xs text-muted-foreground", className)}
      >
        Hand-made snapshot · {prebuild.ref}
      </span>
    );
  }
  const repos = prebuildRepos(prebuild);
  const image = "image" in spec.source ? spec.source.image : undefined;
  const steps = spec.build?.length ?? 0;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {repos.map((repo) => (
        <RepoChip key={repo.clonePath} repo={repo} />
      ))}
      {(spec.ports ?? [])
        .filter((port) => port.public)
        .map((port) => (
          <PortChip key={port.name} port={port} processes={spec.processes} />
        ))}
      {image ? (
        <Badge
          variant="neutral"
          title={`Base image: ${image}`}
          className="font-mono font-normal"
        >
          {image}
        </Badge>
      ) : null}
      {steps > 0 ? (
        <span className="text-xs text-muted-foreground">
          {countLabel(steps, "setup step")}
        </span>
      ) : null}
    </div>
  );
}
