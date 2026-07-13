import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

const TABS = [
  { to: "/settings/api-keys", label: "API Keys" },
  { to: "/settings/ssh-keys", label: "SSH Keys" },
  { to: "/settings/secrets", label: "Secrets" },
  { to: "/settings/organizations", label: "Organizations" },
  { to: "/settings/policy", label: "Org Policy" },
  { to: "/settings/toolboxes", label: "Toolboxes & Toolsets" },
  { to: "/settings/prebuilds", label: "Prebuilds" },
  { to: "/settings/templates", label: "Templates" },
  { to: "/settings/config", label: "Config" },
] as const;

function SettingsLayout() {
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
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
