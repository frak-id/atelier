/** How risky an agent permission prompt looks, lowest first. */
export const PERMISSION_RISKS = ["low", "medium", "high"] as const;
export type PermissionRisk = (typeof PERMISSION_RISKS)[number];

/** A person's enabled integration connection as the permission hub reads
 * it (credential decrypted); one shape for the service and the hub. */
export interface PermissionConnection {
  integrationId: string;
  credential?: string;
  minRisk: PermissionRisk;
  delaySeconds: number;
}

export interface PermissionPresentation {
  /** Plain-language label — what the agent wants to do. */
  what: string;
  risk: PermissionRisk;
  riskLabel: string;
}

const DELETE: PermissionPresentation = {
  what: "Delete files",
  risk: "high",
  riskLabel: "Destructive",
};
const EXECUTE: PermissionPresentation = {
  what: "Run a command",
  risk: "high",
  riskLabel: "Runs code",
};
const EDIT: PermissionPresentation = {
  what: "Edit files",
  risk: "medium",
  riskLabel: "Changes files",
};
const FETCH: PermissionPresentation = {
  what: "Access the network",
  risk: "medium",
  riskLabel: "Network access",
};
const READ: PermissionPresentation = {
  what: "Read files",
  risk: "low",
  riskLabel: "Read-only",
};

/** ACP `ToolKind` → presentation. `other` (and unknown kinds) fall through
 * to the label heuristic. */
const KIND_PRESENTATION: Record<string, PermissionPresentation> = {
  delete: DELETE,
  execute: EXECUTE,
  edit: EDIT,
  move: { ...EDIT, what: "Move files" },
  fetch: FETCH,
  read: READ,
  search: { ...READ, what: "Search files" },
  think: { ...READ, what: "Think" },
  switch_mode: {
    what: "Switch mode",
    risk: "medium",
    riskLabel: "Changes behaviour",
  },
};

/** Label keywords, checked in order (most dangerous first). */
const LABEL_RULES: { words: string[]; presentation: PermissionPresentation }[] =
  [
    { words: ["delete", "remove", "rm"], presentation: DELETE },
    {
      words: ["exec", "execute", "bash", "shell", "run", "command"],
      presentation: EXECUTE,
    },
    {
      words: ["write", "edit", "patch", "create", "modify"],
      presentation: EDIT,
    },
    {
      words: ["fetch", "webfetch", "network", "http", "https", "web"],
      presentation: FETCH,
    },
    { words: ["read", "view", "list"], presentation: READ },
  ];

/**
 * Humanise and classify a permission prompt. The ACP tool kind is
 * authoritative when given; otherwise a keyword heuristic on the free-text
 * label (matched on whole words, so "runtime.ts" is not "run"). A label
 * wrapped in backticks is a shell command, whatever it says. Unknown labels
 * keep their verbatim text at `medium`, never under-warned. One rule for the
 * console's risk badge and the integrations' `minRisk` (connection filter).
 */
export function permissionPresentation(
  label: string,
  toolKind?: string,
): PermissionPresentation {
  const byKind = toolKind ? KIND_PRESENTATION[toolKind] : undefined;
  if (byKind) return byKind;
  if (/^`[^`]+`$/.test(label.trim())) return EXECUTE;
  const words = new Set(
    label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  for (const { words: keywords, presentation } of LABEL_RULES) {
    if (keywords.some((k) => words.has(k))) return presentation;
  }
  return { what: label, risk: "medium", riskLabel: "Unrecognised" };
}
