/**
 * Keeps the git credential of running sandboxes current. A boot writes the
 * owner's git files (`/etc/gitconfig` and `GIT_CREDENTIALS_PATH`) only once,
 * but the token behind them changes: a GitHub App installation token lasts
 * an hour, a service account's static token can be edited, and a person who
 * signs in again gets a new OAuth token (GitHub may revoke the older ones).
 *
 * Every tick, for each running sandbox with an owner, the owner's current
 * git files are written when their token or identity differs from what was
 * last written there. The gitconfig goes too: a boot whose mint failed wrote
 * one without the credential helper. A service account whose credential was
 * removed gets an empty credential file, so its sandboxes don't keep the old
 * token. A login calls `refreshOwner` so the person's sandboxes don't wait
 * for the next tick. Writes to one sandbox run one after the other, each
 * resolving the credential when its turn comes, so the last write always
 * carries the newest token.
 *
 * Lives in api/ because it composes runtime (the sandboxes, the file write)
 * with control (who owns them, their credential).
 */

import type { GitCredentialService } from "../control/index.ts";
import type { RuntimeService } from "../runtime/index.ts";
import {
  buildGitAttributionFiles,
  GIT_CREDENTIALS_PATH,
  OWNER_ID_METADATA,
} from "../shared/lib/git-attribution.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("git-credential-refresh");

/** Sandboxes written in parallel. */
const WRITE_CONCURRENCY = 4;

/** What `written` records for an emptied credential file. */
const CLEARED = "";

type GitFile = Parameters<RuntimeService["writeFilesQuietly"]>[1][number];

interface Target {
  id: string;
  ownerId: string;
}

export interface GitCredentialRefreshDeps {
  runtime: Pick<RuntimeService, "list" | "writeFilesQuietly">;
  credentials: Pick<GitCredentialService, "resolve">;
}

export class GitCredentialRefresher {
  /** The token and identity last written, per sandbox. */
  private readonly written = new Map<string, string>();
  /** The last queued write, per sandbox. */
  private readonly queue = new Map<string, Promise<void>>();

  constructor(private readonly deps: GitCredentialRefreshDeps) {}

  /** Every running sandbox that has an owner. */
  async tick(): Promise<void> {
    const running = this.running();
    const live = new Set(running.map((t) => t.id));
    for (const id of this.written.keys()) {
      if (!live.has(id)) this.written.delete(id);
    }
    await this.refreshAll(running);
  }

  /** The running sandboxes of one owner, now (after a login). Never
   * rejects. */
  async refreshOwner(ownerId: string): Promise<void> {
    await this.refreshAll(this.running().filter((t) => t.ownerId === ownerId));
  }

  private running(): Target[] {
    const targets: Target[] = [];
    for (const s of this.deps.runtime.list()) {
      const ownerId = s.metadata?.[OWNER_ID_METADATA];
      if (s.status === "running" && ownerId) {
        targets.push({ id: s.id, ownerId });
      }
    }
    return targets;
  }

  private async refreshAll(targets: Target[]): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const target = targets[next++];
        if (!target) return;
        try {
          await this.enqueue(target);
        } catch (err) {
          log.warn(
            { id: target.id, err: err instanceof Error ? err.message : "?" },
            "git credential refresh failed",
          );
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(WRITE_CONCURRENCY, targets.length) },
        worker,
      ),
    );
  }

  private enqueue({ id, ownerId }: Target): Promise<void> {
    const previous = this.queue.get(id) ?? Promise.resolve();
    const run = previous.then(
      () => this.refresh(id, ownerId),
      () => this.refresh(id, ownerId),
    );
    this.queue.set(id, run);
    const settle = () => {
      if (this.queue.get(id) === run) this.queue.delete(id);
    };
    run.then(settle, settle);
    return run;
  }

  private async refresh(id: string, ownerId: string): Promise<void> {
    const { token, identity, noCredential } =
      await this.deps.credentials.resolve(ownerId);
    // A failed mint, an unreadable secret or a person whose token GitHub
    // rejected keeps the last token. The identity is part of the key: an
    // edited git name/email is applied too.
    const desired = token
      ? JSON.stringify([token, identity?.name, identity?.email])
      : noCredential
        ? CLEARED
        : undefined;
    if (desired === undefined || this.written.get(id) === desired) return;
    const files: GitFile[] = token
      ? buildGitAttributionFiles({ identity, githubToken: token }).flatMap(
          (f) =>
            typeof f.content === "string" ? [{ ...f, content: f.content }] : [],
        )
      : [
          {
            path: GIT_CREDENTIALS_PATH,
            content: "",
            mode: "0600",
            owner: "dev",
          },
        ];
    const { results } = await this.deps.runtime.writeFilesQuietly(id, files);
    const failed = results.find((r) => !r.success);
    if (failed) throw new Error(failed.error ?? "write failed");
    this.written.set(id, desired);
  }
}
