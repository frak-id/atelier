import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Toolsets are now managed alongside their toolboxes on a single page — this
 * old route redirects to the merged view.
 */
export const Route = createFileRoute("/settings/toolsets")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/toolboxes" });
  },
});
