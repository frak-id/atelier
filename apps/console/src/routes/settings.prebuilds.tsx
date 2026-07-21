import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for the prebuilds settings section. The list (index) and the
 * new/edit editor routes are sibling children rendered here via <Outlet/>. */
export const Route = createFileRoute("/settings/prebuilds")({
  component: PrebuildsLayout,
});

function PrebuildsLayout() {
  return <Outlet />;
}
