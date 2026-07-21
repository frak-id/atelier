import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for the toolboxes settings section. The list (index) and the
 * new/edit editor routes are sibling children rendered here via <Outlet/>. */
export const Route = createFileRoute("/settings/toolboxes")({
  component: ToolboxesLayout,
});

function ToolboxesLayout() {
  return <Outlet />;
}
