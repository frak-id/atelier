import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Code,
  KeyRound,
  Plus,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { type ComponentType, useState } from "react";
import { secretsListQuery } from "@/api/queries/secrets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { OwnerScope } from "@/lib/orgs";
import {
  missingSecrets,
  pendingSuggestions,
  type ToolboxSuggestion,
} from "@/lib/toolbox-suggestions";

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  opencode: SquareTerminal,
  "pi-cliproxy": Bot,
  "code-server": Code,
};

/** Text with `backtick` spans rendered as code. */
export function InlineCode({ text }: { text: string }) {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments of a fixed string
      <code key={i} className="break-all font-mono text-[0.85em]">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/**
 * The suggested toolboxes an org doesn't have yet. Laid out for an org
 * without toolboxes (its starting point); folded behind a toggle once it has
 * some. Renders nothing once every suggestion is added.
 */
export function ToolboxSuggestions({
  scope,
  toolboxes,
}: {
  scope: OwnerScope;
  toolboxes: readonly { slug: string }[];
}) {
  const empty = toolboxes.length === 0;
  const [open, setOpen] = useState(empty);
  const suggestions = pendingSuggestions(toolboxes);
  const needsSecrets = suggestions.some((s) => s.secrets.length > 0);
  const { data: secrets } = useQuery({
    ...secretsListQuery(scope.orgId),
    enabled: needsSecrets && open,
  });

  if (suggestions.length === 0) return null;

  const grid = (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {suggestions.map((suggestion) => (
        <SuggestionCard
          key={suggestion.id}
          suggestion={suggestion}
          owner={scope.owner}
          missing={secrets ? missingSecrets(suggestion, secrets) : undefined}
        />
      ))}
    </div>
  );

  if (empty) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          No toolboxes yet. Base images ship no coding agent: start from a
          suggestion.
        </p>
        {grid}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
      >
        {open ? <ChevronDown /> : <ChevronRight />}
        Suggested toolboxes
        <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
          {suggestions.length}
        </span>
      </Button>
      {open ? grid : null}
    </div>
  );
}

function SuggestionCard({
  suggestion,
  owner,
  missing,
}: {
  suggestion: ToolboxSuggestion;
  owner: string;
  /** Secrets the org lacks; `undefined` while unknown. */
  missing: string[] | undefined;
}) {
  const Icon = ICONS[suggestion.id] ?? Wrench;
  const { harness } = suggestion.input;
  return (
    <Card className="border-dashed">
      <CardContent className="flex h-full flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">
            {suggestion.title}
          </span>
          {harness ? (
            <Badge variant="outline" className="ml-auto shrink-0">
              harness: {harness}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{suggestion.summary}</p>
        {suggestion.secrets.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <KeyRound className="size-3.5 shrink-0" />
            {suggestion.secrets.map((name) =>
              missing?.includes(name) ? (
                <Badge
                  key={name}
                  variant="warning"
                  title="Not set in this organization yet"
                >
                  {name} missing
                </Badge>
              ) : (
                <code key={name} className="font-mono">
                  {name}
                </code>
              ),
            )}
          </div>
        ) : null}
        <Button
          asChild
          size="sm"
          variant="outline"
          className="mt-auto self-end"
        >
          <Link
            to="/library/toolboxes/new"
            search={{ owner, suggestion: suggestion.id }}
          >
            <Plus />
            Add
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
