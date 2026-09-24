import { LogOut, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/providers/theme";

/** The signed-in user, the theme toggle and sign out: the right end of both
 * the developer console's header and the Launchpad's. */
export function AccountControls({
  username,
  onLogout,
}: {
  username: string;
  onLogout: () => void;
}) {
  const { theme, toggle } = useTheme();
  const themeLabel = theme === "dark" ? "Switch to light" : "Switch to dark";
  return (
    <>
      <span className="hidden px-1 text-sm text-muted-foreground sm:inline">
        {username}
      </span>
      <Button
        variant="ghost"
        size="icon"
        onClick={toggle}
        aria-label={themeLabel}
        title={themeLabel}
      >
        {theme === "dark" ? <Sun /> : <Moon />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onLogout}
        aria-label="Sign out"
        title="Sign out"
      >
        <LogOut />
      </Button>
    </>
  );
}
