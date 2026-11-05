import { useNavigate } from "@tanstack/react-router";
import { GitFork } from "lucide-react";
import { useForkSandbox } from "@/api/queries/sandboxes";
import { Button } from "@/components/ui/button";

/** Fork a sandbox and open the copy while it boots. */
export function ForkButton({
  sandboxId,
  size = "sm",
  iconOnly = false,
}: {
  sandboxId: string;
  size?: "sm" | "icon" | "touch";
  iconOnly?: boolean;
}) {
  const fork = useForkSandbox();
  const navigate = useNavigate();
  return (
    <Button
      variant="outline"
      size={size}
      loading={fork.isPending}
      aria-label="Fork sandbox"
      title="Fork"
      onClick={() =>
        fork.mutate(sandboxId, {
          onSuccess: (id) => {
            if (id)
              navigate({
                to: "/sandboxes/$sandboxId",
                params: { sandboxId: id },
              });
          },
        })
      }
    >
      <GitFork />
      {iconOnly ? null : "Fork"}
    </Button>
  );
}
