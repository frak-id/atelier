import { createFileRoute } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const Route = createFileRoute("/")({
  component: SandboxesPage,
});

function SandboxesPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-4 text-xl font-semibold">Sandboxes</h1>
      <Card>
        <CardHeader>
          <CardTitle>No sandboxes yet</CardTitle>
          <CardDescription>
            The sandbox fleet view lands in the next milestone.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Connected to the Atelier v2 server.
        </CardContent>
      </Card>
    </div>
  );
}
