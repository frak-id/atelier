import { Box, Github, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { API_HOST, setAuthToken } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AUTH_ORG_NAME } from "@/config";

interface LoginPageProps {
  onLoginSuccess: () => void;
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const loginToken = params.get("login_token");
    const loginError = params.get("login_error");

    if (loginToken) {
      setAuthToken(loginToken);
      window.history.replaceState({}, "", window.location.pathname);
      onLoginSuccess();
      return;
    }

    if (loginError) {
      setError(getErrorMessage(loginError));
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [onLoginSuccess]);

  const handleGitHubLogin = () => {
    setIsLoading(true);
    setError(null);
    window.location.href = `${API_HOST}/auth/github`;
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <Box className="h-10 w-10 text-primary" />
          </div>
          <CardTitle className="text-xl">Frak Sandbox</CardTitle>
          <p className="text-sm text-muted-foreground">
            Sign in with GitHub to continue
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">
              {error}
            </div>
          )}
          <Button
            onClick={handleGitHubLogin}
            className="w-full"
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Redirecting...
              </>
            ) : (
              <>
                <Github className="mr-2 h-4 w-4" />
                Sign in with GitHub
              </>
            )}
          </Button>
          {AUTH_ORG_NAME && (
            <p className="text-xs text-center text-muted-foreground">
              Access restricted to {AUTH_ORG_NAME} organization members
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function getErrorMessage(errorCode: string): string {
  switch (errorCode) {
    case "unauthorized":
      return AUTH_ORG_NAME
        ? `You are not authorized. Only ${AUTH_ORG_NAME} organization members can sign in.`
        : "You are not authorized to access this application.";
    case "no_code":
      return "GitHub authentication failed. Please try again.";
    case "callback_failed":
      return "Authentication failed. Please try again.";
    default:
      return `Authentication error: ${errorCode}`;
  }
}
