import { useQuery } from "@tanstack/react-query";
import { Sun } from "lucide-react";
import { useState } from "react";
import { sandboxActivityQuery, useKeepAwake } from "@/api/queries/sandboxes";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { keepAwakeChoices, keepAwakeUntil } from "@/lib/idle";

/**
 * Keep a running sandbox from being idle-paused for a few hours (or let it
 * sleep again). The operator's maximum comes from the activity query, which
 * is only fetched while the dialog is open.
 */
export function KeepAwakeButton({
  sandboxId,
  size = "sm",
  iconOnly = false,
}: {
  sandboxId: string;
  size?: "sm" | "icon" | "touch";
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState("8");
  const keepAwake = useKeepAwake();
  const { data: activity } = useQuery({
    ...sandboxActivityQuery(sandboxId),
    enabled: open,
  });
  const choices = activity ? keepAwakeChoices(activity.maxKeepAwakeHours) : [];
  const selected = choices.some((c) => c.value === hours)
    ? hours
    : (choices[0]?.value ?? hours);
  const awakeUntil = activity?.keepAwakeUntil;

  return (
    <>
      <Button
        variant="outline"
        size={size}
        onClick={() => setOpen(true)}
        aria-label="Keep sandbox awake"
        title="Keep awake"
      >
        <Sun />
        {iconOnly ? null : "Keep awake"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keep awake</DialogTitle>
            <DialogDescription>
              {awakeUntil
                ? `Kept awake until ${new Date(awakeUntil).toLocaleString()}.`
                : "Skip the idle auto-pause for a while."}
            </DialogDescription>
          </DialogHeader>
          <NativeSelect
            value={selected}
            onChange={(e) => setHours(e.target.value)}
            aria-label="Keep awake for"
            disabled={choices.length === 0}
          >
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </NativeSelect>
          <DialogFooter>
            {awakeUntil ? (
              <Button
                variant="outline"
                loading={keepAwake.isPending}
                onClick={() =>
                  keepAwake.mutate(
                    { id: sandboxId, until: null },
                    { onSuccess: () => setOpen(false) },
                  )
                }
              >
                Let it sleep
              </Button>
            ) : null}
            <Button
              loading={keepAwake.isPending}
              disabled={choices.length === 0}
              onClick={() =>
                keepAwake.mutate(
                  { id: sandboxId, until: keepAwakeUntil(selected) },
                  { onSuccess: () => setOpen(false) },
                )
              }
            >
              Keep awake
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
