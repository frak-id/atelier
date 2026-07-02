import { Github } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const LOGIN_ERRORS: Record<string, string> = {
  unauthorized: "This GitHub account is not authorized for Atelier.",
  no_code: "GitHub did not return an authorization code. Try again.",
  callback_failed: "Sign-in failed during the GitHub callback. Try again.",
};

export function LoginPage() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
    }
  }, []);

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
              window.location.href = "/auth/github";
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
