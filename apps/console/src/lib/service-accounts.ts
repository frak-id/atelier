/**
 * Pure logic of the Service accounts page: the form state, the request
 * bodies it produces, and the one-line GitHub summary of an account.
 */

export type ServiceAccountRole = "owner" | "member";

/** The GitHub credential as the list returns it (never any secret). */
export type GithubSummary =
  | { kind: "none" }
  | {
      kind: "app";
      appId: string;
      installationId: string;
      repositories?: string[];
      permissions?: Record<string, "read" | "write">;
    }
  | { kind: "token"; gitName: string; gitEmail: string };

/** `remove` is an edit-only choice: it sends `github: null`. */
export type GithubChoice = "none" | "app" | "token" | "remove";

export interface ServiceAccountForm {
  name: string;
  description: string;
  orgId: string;
  role: ServiceAccountRole;
  githubChoice: GithubChoice;
  appId: string;
  installationId: string;
  privateKey: string;
  /** Bare repo names, comma or space separated. */
  repositories: string;
  /** `contents:write, pull_requests:read`, comma or space separated. */
  permissions: string;
  token: string;
  gitName: string;
  gitEmail: string;
}

export interface ServiceAccountLike {
  name: string;
  description: string;
  orgId: string;
  role: ServiceAccountRole | null;
  github: GithubSummary;
}

export type GithubInput =
  | {
      kind: "app";
      appId: string;
      installationId: string;
      privateKey?: string;
      repositories?: string[];
      permissions?: Record<string, "read" | "write">;
    }
  | { kind: "token"; token?: string; gitName: string; gitEmail: string };

/** Splits on commas and whitespace, drops blanks and duplicates. */
export function parseRepositories(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

/** Parses `name:read` / `name=write` tokens, or returns the bad token. */
export function parsePermissions(
  text: string,
):
  | { ok: true; permissions: Record<string, "read" | "write"> }
  | { ok: false; invalid: string } {
  const permissions: Record<string, "read" | "write"> = {};
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    const match = /^([a-z_]+)[:=](read|write)$/.exec(token);
    if (!match?.[1] || !match[2]) return { ok: false, invalid: token };
    permissions[match[1]] = match[2] as "read" | "write";
  }
  return { ok: true, permissions };
}

export function permissionsToText(
  permissions: Record<string, string> | undefined,
): string {
  return Object.entries(permissions ?? {})
    .map(([name, level]) => `${name}:${level}`)
    .join(", ");
}

export function githubSummaryText(github: GithubSummary): string {
  switch (github.kind) {
    case "app":
      return `GitHub App ${github.appId} / installation ${github.installationId}`;
    case "token":
      return `Static token as ${github.gitName}`;
    default:
      return "No GitHub credential";
  }
}

export function emptyForm(orgId = ""): ServiceAccountForm {
  return {
    name: "",
    description: "",
    orgId,
    role: "member",
    githubChoice: "none",
    appId: "",
    installationId: "",
    privateKey: "",
    repositories: "",
    permissions: "",
    token: "",
    gitName: "",
    gitEmail: "",
  };
}

/** The edit form: stored settings filled in, secret fields left empty. */
export function formFromAccount(
  account: ServiceAccountLike,
): ServiceAccountForm {
  const form: ServiceAccountForm = {
    ...emptyForm(account.orgId),
    name: account.name,
    description: account.description,
    role: account.role ?? "member",
    githubChoice: account.github.kind,
  };
  if (account.github.kind === "app") {
    form.appId = account.github.appId;
    form.installationId = account.github.installationId;
    form.repositories = (account.github.repositories ?? []).join(", ");
    form.permissions = permissionsToText(account.github.permissions);
  } else if (account.github.kind === "token") {
    form.gitName = account.github.gitName;
    form.gitEmail = account.github.gitEmail;
  }
  return form;
}

/** The first problem with the form, or null when it can be sent. `current`
 * is the stored credential kind when editing: the secret may then stay empty
 * as long as the kind is unchanged. */
export function validateForm(
  form: ServiceAccountForm,
  current?: GithubSummary["kind"],
): string | null {
  if (!form.orgId) return "Pick an organization";
  if (form.githubChoice === "app") {
    if (!form.appId.trim() || !form.installationId.trim()) {
      return "App ID and installation ID are required";
    }
    if (current !== "app" && !form.privateKey.trim()) {
      return "The private key is required";
    }
    const parsed = parsePermissions(form.permissions);
    if (!parsed.ok) return `Invalid permission "${parsed.invalid}"`;
  }
  if (form.githubChoice === "token") {
    if (!form.gitName.trim() || !form.gitEmail.trim()) {
      return "Git name and email are required";
    }
    if (current !== "token" && !form.token.trim()) {
      return "The token is required";
    }
  }
  return null;
}

/** The `github` field: undefined = leave as is, null = remove. */
export function githubInputFromForm(
  form: ServiceAccountForm,
): GithubInput | null | undefined {
  switch (form.githubChoice) {
    case "remove":
      return null;
    case "app": {
      const parsed = parsePermissions(form.permissions);
      const repositories = parseRepositories(form.repositories);
      const permissions = parsed.ok ? parsed.permissions : {};
      return {
        kind: "app",
        appId: form.appId.trim(),
        installationId: form.installationId.trim(),
        ...(form.privateKey.trim() ? { privateKey: form.privateKey } : {}),
        ...(repositories.length > 0 ? { repositories } : {}),
        ...(Object.keys(permissions).length > 0 ? { permissions } : {}),
      };
    }
    case "token":
      return {
        kind: "token",
        ...(form.token.trim() ? { token: form.token.trim() } : {}),
        gitName: form.gitName.trim(),
        gitEmail: form.gitEmail.trim(),
      };
    default:
      return undefined;
  }
}

export function createBody(form: ServiceAccountForm) {
  const github = githubInputFromForm(form);
  const description = form.description.trim();
  return {
    name: form.name.trim(),
    orgId: form.orgId,
    role: form.role,
    ...(description ? { description } : {}),
    ...(github ? { github } : {}),
  };
}

export function updateBody(form: ServiceAccountForm) {
  const github = githubInputFromForm(form);
  return {
    description: form.description.trim(),
    orgId: form.orgId,
    role: form.role,
    ...(github === undefined ? {} : { github }),
  };
}
