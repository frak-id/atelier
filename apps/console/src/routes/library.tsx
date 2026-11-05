import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/library")({
  component: LibraryLayout,
});

const TABS = [
  { to: "/library/prebuilds", label: "Prebuilds" },
  { to: "/library/toolboxes", label: "Toolboxes & Toolsets" },
  { to: "/library/images", label: "Images" },
] as const;

function LibraryLayout() {
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">Library</h1>
      <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1">
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            className="shrink-0 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
