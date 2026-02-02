import { createFileRoute } from "@tanstack/react-router";
import { TerminalEmulator } from "@/components/terminal-emulator";

export const Route = createFileRoute("/sandbox/$id/terminal")({
  component: SandboxTerminalPage,
});

function SandboxTerminalPage() {
  const { id } = Route.useParams();
  return (
    <div className="fixed inset-0 z-50 bg-[#09090b]">
      <TerminalEmulator sandboxId={id} className="w-full h-full" />
    </div>
  );
}
