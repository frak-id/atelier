import { createFileRoute } from "@tanstack/react-router";
import { MultiTerminal } from "@/components/multi-terminal";

export const Route = createFileRoute("/sandbox/$id/terminal")({
  component: SandboxTerminalPage,
});

function SandboxTerminalPage() {
  const { id } = Route.useParams();
  return (
    <div className="fixed inset-0 z-50 bg-[#09090b]">
      <MultiTerminal sandboxId={id} className="w-full h-full" />
    </div>
  );
}
