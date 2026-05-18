import { AlertTriangle } from "lucide-react";
import type { Sandbox } from "@/api/client";

interface SandboxWarningsBlockProps {
  warnings: Sandbox["warnings"];
}

/**
 * Yellow banner listing soft-failure conditions recorded on the sandbox row.
 *
 * Currently shows agent-name drift (configured agent not present in the
 * remote opencode binary). The prompt still went out, but with opencode's
 * default agent instead of the requested one. Operator action: update the
 * session template to a name that exists in the current opencode build.
 */
export function SandboxWarningsBlock({ warnings }: SandboxWarningsBlockProps) {
  if (!warnings?.length) return null;

  return (
    <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-yellow-700 dark:text-yellow-400">
        <AlertTriangle className="h-4 w-4" />
        {warnings.length === 1
          ? "1 sandbox warning"
          : `${warnings.length} sandbox warnings`}
      </div>
      <ul className="space-y-1.5 text-xs">
        {warnings.map((w) => (
          <SandboxWarningRow key={`${w.code}-${w.createdAt}`} warning={w} />
        ))}
      </ul>
    </div>
  );
}

function SandboxWarningRow({
  warning,
}: {
  warning: NonNullable<Sandbox["warnings"]>[number];
}) {
  const available = warning.context?.available;
  return (
    <li className="text-yellow-900 dark:text-yellow-200">
      <span className="font-mono text-[0.65rem] uppercase tracking-wide text-yellow-700/70 dark:text-yellow-400/70 mr-1.5">
        {warning.code}
      </span>
      {warning.message}
      {Array.isArray(available) && available.length > 0 && (
        <div className="mt-0.5 text-yellow-800/80 dark:text-yellow-300/70">
          Available agents: {available.join(", ")}
        </div>
      )}
    </li>
  );
}
