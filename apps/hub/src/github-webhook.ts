/**
 * GitHub push webhook → re-index. Only the signature check and the event
 * triage live here; the work is queued on the {@link IndexRunner}, so the
 * webhook answers well inside GitHub's 10 s delivery timeout.
 */
import { timingSafeEqual } from "node:crypto";
import type { RepoConfig } from "./config.ts";

export function signPayload(secret: string, body: string): string {
  const mac = new Bun.CryptoHasher("sha256", secret).update(body);
  return `sha256=${mac.digest("hex")}`;
}

/** Constant-time check of `X-Hub-Signature-256`. */
export function verifySignature(
  secret: string,
  body: string,
  header: string | null,
): boolean {
  if (!header) return false;
  const expected = Buffer.from(signPayload(secret, body));
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

interface PushPayload {
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository?: { full_name?: string };
}

export type WebhookDecision =
  | { action: "index"; repo: RepoConfig; revision?: string }
  | { action: "ignore"; reason: string };

/** Decides what a delivery means for the tracked repositories. */
export function triageDelivery(
  event: string | null,
  payload: unknown,
  repos: RepoConfig[],
): WebhookDecision {
  if (event === "ping") return { action: "ignore", reason: "ping" };
  if (event !== "push") {
    return { action: "ignore", reason: `event ${event ?? "?"} not handled` };
  }
  const push = payload as PushPayload;
  const fullName = push.repository?.full_name?.toLowerCase();
  const repo = repos.find((r) => r.repo.toLowerCase() === fullName);
  if (!repo) return { action: "ignore", reason: "repository not tracked" };
  if (push.ref !== `refs/heads/${repo.branch}`) {
    return { action: "ignore", reason: `ref ${push.ref} not tracked` };
  }
  if (push.deleted) return { action: "ignore", reason: "branch deleted" };
  return { action: "index", repo, revision: push.after };
}
