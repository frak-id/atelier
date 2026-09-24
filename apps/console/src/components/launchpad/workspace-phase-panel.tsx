import {
  AlertTriangle,
  AppWindow,
  Loader2,
  Moon,
  RotateCw,
  Sunrise,
} from "lucide-react";
import {
  useWorkspaceAction,
  type WorkspaceDetail,
} from "@/api/queries/launchpad";
import { WorkspaceGuide } from "@/components/launchpad/workspace-guide";
import { Button } from "@/components/ui/button";
import { LaunchpadIconView, PHASE_PRESENTATION } from "@/lib/launchpad";

/** Not ready: a calm, full-width status panel with the one action that
 * helps (wake up, try again) and a preview of the tools to come. */
export function WorkspacePhasePanel({
  workspace,
}: {
  workspace: WorkspaceDetail;
}) {
  const action = useWorkspaceAction();
  const p = PHASE_PRESENTATION[workspace.phase];
  return (
    <div className="mx-auto grid w-full max-w-5xl flex-1 gap-8 px-4 py-12 lg:grid-cols-[1fr_20rem]">
      <div className="flex flex-col items-center justify-center gap-5 rounded-xl border border-dashed px-6 py-16 text-center">
        {p.busy ? (
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        ) : workspace.phase === "sleeping" ? (
          <Moon className="size-8 text-muted-foreground" />
        ) : (
          <AlertTriangle className="size-8 text-danger" />
        )}
        <div className="max-w-md space-y-2">
          <h2 className="text-lg font-semibold">
            {workspace.phase === "sleeping"
              ? "This workspace is asleep"
              : p.label}
          </h2>
          <p className="text-sm text-muted-foreground">{p.hint}</p>
          {workspace.phase === "failed" && workspace.error ? (
            <details className="text-left text-xs text-muted-foreground">
              <summary className="cursor-pointer text-center">Details</summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono">
                {workspace.error}
              </pre>
            </details>
          ) : null}
        </div>
        {workspace.phase === "sleeping" ? (
          <Button
            size="lg"
            loading={action.isPending}
            onClick={() => action.mutate({ id: workspace.id, action: "wake" })}
          >
            <Sunrise />
            Wake up
          </Button>
        ) : workspace.phase === "failed" ? (
          <Button
            size="lg"
            loading={action.isPending}
            onClick={() => action.mutate({ id: workspace.id, action: "retry" })}
          >
            <RotateCw />
            Try again
          </Button>
        ) : null}
      </div>
      <aside className="space-y-6">
        {workspace.services.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              {p.busy ? "Coming up" : "Your tools"}
            </h3>
            <ul className="space-y-1">
              {workspace.services.map((service) => (
                <li
                  key={service.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground"
                >
                  <LaunchpadIconView
                    icon={service.icon}
                    fallback={AppWindow}
                    className="size-4"
                  />
                  {service.label}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <WorkspaceGuide guide={workspace.guide} />
      </aside>
    </div>
  );
}
