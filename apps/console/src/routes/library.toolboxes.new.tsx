import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft, Lightbulb } from "lucide-react";
import { ToolboxEditor } from "@/components/toolbox-editor";
import { InlineCode } from "@/components/toolbox-suggestions";
import {
  findToolboxSuggestion,
  type ToolboxSuggestion,
} from "@/lib/toolbox-suggestions";

export const Route = createFileRoute("/library/toolboxes/new")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { owner: string; suggestion?: string } => ({
    owner: typeof search.owner === "string" ? search.owner : "me",
    // A suggested toolbox to start from (`lib/toolbox-suggestions.ts`).
    ...(typeof search.suggestion === "string"
      ? { suggestion: search.suggestion }
      : {}),
  }),
  component: NewToolboxPage,
});

function NewToolboxPage() {
  const { owner, suggestion: suggestionId } = Route.useSearch();
  const suggestion = findToolboxSuggestion(suggestionId);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link
        to="/library/toolboxes"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Back to toolboxes
      </Link>
      <h1 className="text-xl font-semibold">
        {suggestion ? `Add ${suggestion.title}` : "Add toolbox"}
      </h1>
      {suggestion ? <SuggestionSetup suggestion={suggestion} /> : null}
      {/* Keyed so switching suggestions in place re-seeds the editor. */}
      <ToolboxEditor
        key={suggestion?.id ?? ""}
        owner={owner}
        initial={suggestion?.input}
      />
    </div>
  );
}

/** What to do before saving a suggested toolbox. */
function SuggestionSetup({ suggestion }: { suggestion: ToolboxSuggestion }) {
  if (suggestion.setup.length === 0) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 p-2.5 text-sm text-info">
      <Lightbulb className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">Before you save</p>
        <ul className="list-disc space-y-1 pl-4">
          {suggestion.setup.map((line) => (
            <li key={line}>
              <InlineCode text={line} />
            </li>
          ))}
        </ul>
        {suggestion.secrets.length > 0 ? (
          <p>
            Manage secrets in{" "}
            <Link to="/settings/secrets" className="underline">
              Settings → Secrets
            </Link>
            .
          </p>
        ) : null}
      </div>
    </div>
  );
}
