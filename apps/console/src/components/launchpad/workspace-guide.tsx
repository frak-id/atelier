import { BookOpen } from "lucide-react";

/** The starter's plain-language how-to, beside the tools. */
export function WorkspaceGuide({ guide }: { guide?: string }) {
  if (!guide) return null;
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <BookOpen className="size-4" />
        How to use this
      </h3>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">
        {guide}
      </p>
    </div>
  );
}
