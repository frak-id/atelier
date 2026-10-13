import { useQueryClient } from "@tanstack/react-query";
import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { queryKeys } from "@/api/queries/keys";
import type { WorkspaceDetail } from "@/api/queries/launchpad";
import { useKeepAwake } from "@/api/queries/sandboxes";
import { Button } from "@/components/ui/button";
import { formatDuration, msUntil } from "@/lib/idle";

/** Shown this long before an unused workspace goes to sleep. */
const NOTICE_MS = 15 * 60_000;
/** "Keep awake" adds this much (always within the operator's bound, which
 * is at least an hour). */
const KEEP_AWAKE_MS = 60 * 60_000;

/**
 * A ready workspace about to go to sleep because nobody used it (idle
 * auto-pause): say so plainly, and offer to keep it awake a while (a long
 * task left running, a read without clicks).
 */
export function WorkspaceSleepNotice({
  workspace,
}: {
  workspace: WorkspaceDetail;
}) {
  const [now, setNow] = useState(() => Date.now());
  const keepAwake = useKeepAwake();
  const queryClient = useQueryClient();
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!workspace.sleepsAt) return null;
  const left = msUntil(workspace.sleepsAt, now);
  if (left > NOTICE_MS) return null;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-3 px-4 pt-3">
      <div className="flex flex-1 flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm">
        <Moon className="size-4 shrink-0 text-warning" />
        <span className="flex-1">
          {left > 0
            ? `Going to sleep in ${formatDuration(left)} because nobody is using it.`
            : "Going to sleep now because nobody is using it."}{" "}
          Your work is saved; you can wake it up any time.
        </span>
        <Button
          size="sm"
          variant="outline"
          loading={keepAwake.isPending}
          onClick={() =>
            keepAwake.mutate(
              {
                id: workspace.id,
                until: new Date(Date.now() + KEEP_AWAKE_MS).toISOString(),
              },
              {
                onSuccess: () =>
                  queryClient.invalidateQueries({
                    queryKey: queryKeys.launchpad.all,
                  }),
              },
            )
          }
        >
          <Sun />
          Keep awake 1 more hour
        </Button>
      </div>
    </div>
  );
}
