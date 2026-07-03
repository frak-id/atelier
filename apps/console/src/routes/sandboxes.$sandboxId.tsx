import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for a single sandbox. The detail view (index) and the sessions
 * view are sibling children rendered here via <Outlet/>; each supplies its
 * own header/breadcrumb. */
export const Route = createFileRoute("/sandboxes/$sandboxId")({
  component: SandboxLayout,
});

function SandboxLayout() {
  return <Outlet />;
}
