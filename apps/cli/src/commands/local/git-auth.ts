/** GitHub-token resolution for `atelier local`: decide whether (and from where)
 * to inject a token into local sandboxes so agents can clone/push private
 * repos. Mode precedence: `--git-auth` flag > persisted choice > "ask". Never
 * prints a token value. */

import pc from "picocolors";
import { loadLocalSettings, saveLocalSettings } from "../../local-settings.ts";
import { fail, line } from "../../output.ts";
import { runCapture } from "../../proc.ts";
import * as ui from "../../ui.ts";

const GIT_AUTH_MODES = ["gh", "env", "pat", "none", "ask"] as const;
export type GitAuthMode = (typeof GIT_AUTH_MODES)[number];

/** Reject an unknown `--git-auth` value with a listing of the valid modes. */
export function assertGitAuthMode(value: string | undefined): void {
  if (value && !GIT_AUTH_MODES.includes(value as GitAuthMode)) {
    fail(
      `--git-auth must be one of: ${GIT_AUTH_MODES.join("|")} (got "${value}")`,
    );
  }
}

const GIT_AUTH_CONSENT_NOTE =
  "The token is injected into sandboxes so agents can clone/push your " +
  "private repos. It's a transient credential (scrubbed before any " +
  "snapshot), but an AI agent running in the sandbox can read — and could " +
  "exfiltrate — it.";

/** Run `gh <args>`, capturing stdout/stderr + exit code (never rejects). Used
 * only to read a token, never to print it. */
const gh = (args: string[]) => runCapture(["gh", ...args]);

/** Best-effort `gh auth token` — undefined if `gh` is missing, unauthenticated,
 * or the call otherwise fails. Never throws, never prints the token. */
async function ghAuthToken(): Promise<string | undefined> {
  const res = await gh(["auth", "token"]);
  if (res.code !== 0) return undefined;
  const token = res.stdout.trim();
  return token || undefined;
}

function envGitToken(): string | undefined {
  return (
    process.env.ATELIER_GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_TOKEN?.trim() ||
    undefined
  );
}

/** Ask for consent before a resolved token is actually injected, unless the
 * user already opted in (persisted) or we're non-interactive (scripted use
 * implies consent — but still say so, once, without printing the token). */
async function ensureTokenConsent(): Promise<boolean> {
  if (loadLocalSettings().tokenConsent) return true;
  if (!ui.isInteractive()) {
    line(pc.dim("Injecting host GitHub token into local sandboxes."));
    return true;
  }
  const consented = await ui.confirm({
    message: `${GIT_AUTH_CONSENT_NOTE} Continue?`,
    initialValue: true,
  });
  if (consented) saveLocalSettings({ tokenConsent: true });
  return consented;
}

interface GitTokenResult {
  token: string | undefined;
  mode: GitAuthMode;
}

/** Gate a resolved token behind one-time consent (persisted). Declining
 * returns undefined — the caller proceeds without a token, not an error. */
async function gated(token: string): Promise<string | undefined> {
  return (await ensureTokenConsent()) ? token : undefined;
}

/** Prompt for and persist a pasted PAT; empty input aborts (no token). */
async function promptForPat(): Promise<string | undefined> {
  const pat = (
    await ui.password({ message: "GitHub personal access token" })
  ).trim();
  if (!pat) return undefined;
  saveLocalSettings({ pat });
  return pat;
}

/** Resolve the GitHub token (if any) to inject into local sandboxes as
 * ATELIER_GITHUB_TOKEN. Mode precedence: --git-auth flag > persisted
 * ~/.atelier/local.json choice > "ask". Never prints the token value. */
export async function resolveGitToken(
  gitAuth: string | undefined,
): Promise<GitTokenResult> {
  assertGitAuthMode(gitAuth);
  const mode: GitAuthMode =
    (gitAuth as GitAuthMode | undefined) ??
    loadLocalSettings().gitAuth ??
    "ask";

  if (mode === "none") return { token: undefined, mode };

  if (mode === "env") {
    const token = envGitToken();
    if (!token) {
      line(
        pc.dim(
          "--git-auth env: no ATELIER_GITHUB_TOKEN/GITHUB_TOKEN found — private repos won't clone.",
        ),
      );
      return { token: undefined, mode };
    }
    return { token: await gated(token), mode };
  }

  if (mode === "gh") {
    const token = await ghAuthToken();
    if (!token) {
      line(
        pc.dim(
          "--git-auth gh: no token from `gh auth token` — run `gh auth login`, or private repos won't clone.",
        ),
      );
      return { token: undefined, mode };
    }
    return { token: await gated(token), mode };
  }

  if (mode === "pat") {
    const stored = loadLocalSettings().pat;
    if (stored) return { token: await gated(stored), mode };
    if (!ui.isInteractive()) {
      line(
        pc.dim(
          "--git-auth pat: no stored token and not interactive — private repos won't clone.",
        ),
      );
      return { token: undefined, mode };
    }
    const pat = await promptForPat();
    return { token: pat ? await gated(pat) : undefined, mode };
  }

  // mode === "ask"
  if (!ui.isInteractive()) {
    // Scripted / non-TTY: NEVER inject an ambient credential without an
    // explicit choice. `ask` is the default, and auto-detecting here would
    // silently bake e.g. a CI runner's GITHUB_TOKEN into a long-lived
    // container. Default to no token; scripted callers opt in explicitly with
    // `--git-auth env|gh|pat`.
    line(
      pc.dim(
        "git auth: skipped (non-interactive) — pass --git-auth env|gh|pat to inject a token.",
      ),
    );
    return { token: undefined, mode };
  }

  // mode === "ask", interactive
  return chooseGitAuthInteractive();
}

type ChosenMode = Exclude<GitAuthMode, "ask">;

/** Interactive picker for the git-auth source: detects what's available (gh /
 * env), records the choice (+consent) to ~/.atelier/local.json, and resolves
 * the token for it. Shared by `up`'s ask-mode and the cockpit's GitHub-auth
 * menu. Assumes an interactive TTY. Never prints the token value. */
export async function chooseGitAuthInteractive(): Promise<GitTokenResult> {
  const envToken = envGitToken();
  const ghToken = await ghAuthToken();
  const options: { value: ChosenMode; label: string; hint?: string }[] = [];
  if (ghToken) {
    options.push({
      value: "gh",
      label: "Use GitHub CLI token (gh auth token)",
      hint: "recommended — reuses your existing gh login",
    });
  }
  if (envToken) {
    options.push({
      value: "env",
      label: "Use ATELIER_GITHUB_TOKEN/GITHUB_TOKEN from your env",
    });
  }
  options.push(
    { value: "pat", label: "Paste a Personal Access Token" },
    { value: "none", label: "None — public repos only" },
  );

  const chosen = await ui.select<ChosenMode>({
    message: `Git auth for private repos in sandboxes? ${GIT_AUTH_CONSENT_NOTE}`,
    options,
  });
  // The selection itself is the consent (the note is in the prompt above), so
  // record it — otherwise `gated()` below would prompt a second time.
  saveLocalSettings(
    chosen === "none"
      ? { gitAuth: chosen }
      : { gitAuth: chosen, tokenConsent: true },
  );

  if (chosen === "none") return { token: undefined, mode: chosen };
  if (chosen === "env") {
    return {
      token: envToken ? await gated(envToken) : undefined,
      mode: chosen,
    };
  }
  if (chosen === "gh") {
    return { token: ghToken ? await gated(ghToken) : undefined, mode: chosen };
  }

  // chosen === "pat"
  const pat = await promptForPat();
  return { token: pat ? await gated(pat) : undefined, mode: chosen };
}
