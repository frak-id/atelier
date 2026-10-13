/** Shared read-side helpers for sandbox display + SSH, used by both the
 * scriptable commands and the interactive browser. */
import { existsSync } from "node:fs";
import type {
  IdleBlocker,
  SandboxActivity,
  SandboxIdleSummary,
  SandboxUrl,
} from "@atelier/spec";
import pc from "picocolors";
import { age, until } from "../output.ts";
import { ATELIER_KEY_PATH } from "../ssh-keys.ts";

const HARNESS = "atelier.dev/harness";
const PREBUILD = "atelier.dev/prebuild";
const WORKSPACE = "atelier.dev/workspace";
const OWNER = "atelier.dev/owner";

type Annotations = Record<string, string> | undefined;

export const harnessOf = (a: Annotations): string => a?.[HARNESS] ?? "-";
export const workspaceOf = (a: Annotations): string | undefined =>
  a?.[WORKSPACE];
export const ownerOf = (a: Annotations): string | undefined => a?.[OWNER];
export const prebuildOf = (a: Annotations): string | undefined => a?.[PREBUILD];

/** A compact one-line descriptor for a sandbox row: harness + workspace/repo +
 * prebuild marker. */
export function describeAnnotations(a: Annotations): string {
  const parts: string[] = [];
  const harness = a?.[HARNESS];
  if (harness) parts.push(harness);
  const ws = a?.[WORKSPACE];
  if (ws) parts.push(ws);
  if (a?.[PREBUILD]) parts.push("prebuilt");
  return parts.join(" · ") || "-";
}

/** The IDLE column of `atelier ps`: when an unused running sandbox will be
 * paused. */
export function idleOf(idle: SandboxIdleSummary | undefined): string {
  switch (idle?.state) {
    case "active":
      if (!idle.pausesAt) return "-";
      return idle.mode === "observe"
        ? pc.dim(`would pause in ${until(idle.pausesAt)}`)
        : `pauses in ${until(idle.pausesAt)}`;
    case "due":
      return pc.yellow("idle");
    case "blocked":
      return pc.dim("held awake");
    default:
      return "-";
  }
}

const BLOCKERS: Record<IdleBlocker, string> = {
  "keep-awake": "kept awake",
  "agent-turn": "an agent turn is running",
  "permission-pending": "an agent waits for a permission answer",
  job: "a job is working on it",
  "lifecycle-op": "a lifecycle operation is running",
  "agent-unreported": "its agent doesn't report activity (older image)",
};

/** One line on idle auto-pause for `atelier get`. */
export function describeIdle(a: SandboxActivity): string {
  if (a.state === "off") return pc.dim("auto-pause off");
  if (a.state === "not-running") {
    return a.idlePausedAt
      ? `paused after ${a.idleMinutes} min without use`
      : pc.dim("not running");
  }
  const status =
    a.state === "blocked"
      ? `held: ${a.blockers
          .map((b) =>
            b === "keep-awake" && a.keepAwakeUntil
              ? `kept awake for ${until(a.keepAwakeUntil)}`
              : BLOCKERS[b],
          )
          .join(", ")}`
      : idleOf(a);
  return [
    a.lastActiveAt ? `last activity ${age(a.lastActiveAt)} ago` : "",
    status,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** `90m`, `8h`, `2d`, `1.5h` → milliseconds (undefined when unparseable). */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(m|h|d)$/.exec(text.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "m" | "h" | "d"
  ];
  return n > 0 ? n * unit : undefined;
}

/**
 * Turn a sandbox's `ssh` URL into an argv for spawning. The runtime emits
 * either a ready-made command string (`ssh id@host -p 2222`, k8s backend) or
 * an `ssh://user@host:port` URI (docker backend) — handle both.
 */
export function sshCommand(urls: SandboxUrl[]): string[] | null {
  const entry = urls.find((u) => u.name === "ssh");
  if (!entry) return null;
  const raw = entry.url.trim();
  // Offer the atelier-managed key when present, so `atelier ssh` works right
  // after `ssh-key setup` without touching `~/.ssh/config` or the agent.
  const identity = existsSync(ATELIER_KEY_PATH) ? ["-i", ATELIER_KEY_PATH] : [];
  if (raw.startsWith("ssh://")) {
    const parsed = new URL(raw);
    const args = ["ssh", ...identity];
    if (parsed.port) args.push("-p", parsed.port);
    args.push(
      parsed.username
        ? `${parsed.username}@${parsed.hostname}`
        : parsed.hostname,
    );
    return args;
  }
  if (raw.startsWith("ssh ")) {
    const [cmd, ...rest] = raw.split(/\s+/);
    return [cmd as string, ...identity, ...rest];
  }
  return null;
}
