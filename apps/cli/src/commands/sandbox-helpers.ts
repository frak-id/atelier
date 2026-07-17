/** Shared read-side helpers for sandbox display + SSH, used by both the
 * scriptable commands and the interactive browser. */
import { existsSync } from "node:fs";
import type { SandboxUrl } from "@atelier/spec";
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
