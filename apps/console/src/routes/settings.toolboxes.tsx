import { createFileRoute, redirect } from "@tanstack/react-router";

/** Moved to the Library: keeps old bookmarks working. */
export const Route = createFileRoute("/settings/toolboxes")({
  beforeLoad: () => {
    throw redirect({ to: "/library/toolboxes" });
  },
});
