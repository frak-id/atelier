import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for Launchpad starter authoring: the list (index) and the new/edit
 * editor routes render here via <Outlet/>. */
export const Route = createFileRoute("/settings/launchpad")({
  component: LaunchpadSettingsLayout,
});

function LaunchpadSettingsLayout() {
  return <Outlet />;
}
