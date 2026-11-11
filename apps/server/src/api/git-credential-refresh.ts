/**
 * Keeps the git credential of running service-account sandboxes current. A
 * GitHub App installation token lasts an hour and a static token can be
 * edited, but a boot writes the credential file only once. Every tick, for
 * each running sandbox owned by a service account, the owner's current git
 * files (`/etc/gitconfig` and `GIT_CREDENTIALS_PATH`) are written when its
 * token differs from the one last written. The gitconfig goes too: a boot
 * whose mint failed wrote one without the credential helper. An account
 * whose credential was removed gets an empty credential file, so its
 * sandboxes don't keep the old token. People's sandboxes are never touched
 * (their token is a boot-time snapshot, as before).
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

export interface GitCredentialRefreshDeps {
  runtime: Pick<RuntimeService, "list" | "writeFilesQuietly">;
  credentials: Pick<GitCredentialService, "resolve">;
  /** Whether the user is a service account. */
  isServiceAccount: (userId: string) => boolean;
}

export class GitCredentialRefresher {
  /** The token and identity last written, per sandbox. */
  private readonly written = new Map<string, string>();

  constructor(private readonly deps: GitCredentialRefreshDeps) {}

  async tick(): Promise<void> {
    const running = this.deps.runtime
      .list()
      .filter((s) => s.status === "running");
    const live = new Set(running.map((s) => s.id));
    for (const id of this.written.keys()) {
      if (!live.has(id)) this.written.delete(id);
    }

    const targets: Array<{ id: string; ownerId: string }> = [];
    for (const s of running) {
      const ownerId = s.metadata?.[OWNER_ID_METADATA];
      if (ownerId && this.deps.isServiceAccount(ownerId)) {
        targets.push({ id: s.id, ownerId });
      }
    }

    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const target = targets[next++];
        if (!target) return;
        try {
          await this.refresh(target.id, target.ownerId);
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

  private async refresh(id: string, ownerId: string): Promise<void> {
    const { token, identity, noCredential } =
      await this.deps.credentials.resolve(ownerId);
    // A failed mint or an unreadable secret keeps the last token. The
    // identity is part of the key: an edited git name/email is applied too.
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
