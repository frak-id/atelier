import { Github } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { httpUrl } from "@/lib/api-base";

const LOGIN_ERRORS: Record<string, string> = {
  unauthorized: "This GitHub account is not authorized for Atelier.",
  no_code: "GitHub did not return an authorization code. Try again.",
  callback_failed: "Sign-in failed during the GitHub callback. Try again.",
};

/** Guards against an auto-login redirect loop if the local session cookie
 * fails to stick for some reason (per browser tab). */
const LOCAL_AUTOLOGIN_GUARD = "atelier_local_autologin";

export function LoginPage() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Until we know the server's auth mode, don't flash the GitHub card: a
  // local/mock server auto-logs the user in, so we redirect instead.
  const [checkingMode, setCheckingMode] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const loginError = params.get("login_error");
    if (loginError) {
      setErrorMessage(LOGIN_ERRORS[loginError] ?? "Sign-in failed. Try again.");
      params.delete("login_error");
      const query = params.toString();
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}`,
      );
      // A failed login means don't bounce straight back into it — show the
      // manual button so the user can retry / read the error.
      setCheckingMode(false);
      return;
    }

    // Auth-bypassed servers (local/mock) have no real GitHub login: hitting
    // /auth/github just mints the local session and redirects home. Do that
    // transparently so `atelier local up` never asks the user for GitHub.
    let cancelled = false;
    fetch(httpUrl("/auth/mode"), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { bypassed: false }))
      .then((data: { bypassed?: boolean }) => {
        if (cancelled) return;
        const alreadyTried = sessionStorage.getItem(LOCAL_AUTOLOGIN_GUARD);
        if (data?.bypassed && !alreadyTried) {
          sessionStorage.setItem(LOCAL_AUTOLOGIN_GUARD, "1");
          window.location.href = httpUrl("/auth/github");
          return;
        }
        setCheckingMode(false);
      })
      .catch(() => {
        if (!cancelled) setCheckingMode(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (checkingMode) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Atelier</CardTitle>
          <CardDescription>Sign in to manage your sandboxes.</CardDescription>
        </CardHeader>
        <div className="p-6 pt-0">
          {errorMessage && (
            <p className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {errorMessage}
            </p>
          )}
          <Button
            className="w-full"
            onClick={() => {
              window.location.href = httpUrl("/auth/github");
            }}
          >
            <Github className="mr-2 size-4" />
            Continue with GitHub
          </Button>
        </div>
      </Card>
    </div>
  );
}
