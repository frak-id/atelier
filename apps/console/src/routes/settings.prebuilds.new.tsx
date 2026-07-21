import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { PrebuildEditor } from "@/components/prebuild-editor";

export const Route = createFileRoute("/settings/prebuilds/new")({
  component: NewPrebuildPage,
});

function NewPrebuildPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link
        to="/settings/prebuilds"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Back to prebuilds
      </Link>
      <h1 className="text-xl font-semibold">New prebuild</h1>
      <PrebuildEditor />
    </div>
  );
}
