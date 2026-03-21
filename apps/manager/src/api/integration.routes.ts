import { Elysia } from "elysia";
import {
  githubAdapter,
  integrationGateway,
  slackAdapter,
} from "../container.ts";
import { GitHubAdapter } from "../modules/integration/adapters/github.adapter.ts";
import { SlackAdapter } from "../modules/integration/adapters/slack.adapter.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("integration-routes");

/** Slack can retry webhook delivery — deduplicate by event_id with a 5-min TTL. */
const DEDUP_TTL_MS = 5 * 60 * 1000;
const recentEventIds = new Map<string, number>();

function isDuplicateEvent(eventId: string): boolean {
  const now = Date.now();
  if (recentEventIds.size > 500) {
    for (const [id, ts] of recentEventIds) {
      if (now - ts > DEDUP_TTL_MS) recentEventIds.delete(id);
    }
  }
  if (recentEventIds.has(eventId)) return true;
  recentEventIds.set(eventId, now);
  return false;
}

function isSlackEnabled(): boolean {
  const { enabled, botToken, signingSecret } = config.integrations.slack;
  return enabled && !!botToken && !!signingSecret;
}

function isGitHubEnabled(): boolean {
  const { enabled, accessToken, webhookSecret } = config.integrations.github;
  return enabled && !!accessToken && !!webhookSecret;
}

const ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function stripMentionTag(text: string, botLogin: string): string {
  return text.replace(new RegExp(`@${botLogin}\\b`, "gi"), "").trim();
}

export const integrationRoutes = new Elysia({
  prefix: "/integrations",
})
  .post("/slack/events", async ({ request, set }) => {
    if (!isSlackEnabled() || !slackAdapter) {
      set.status = 404;
      return { error: "NOT_FOUND", message: "Slack integration disabled" };
    }

    const rawBody = await request.clone().text();

    const signature = request.headers.get("x-slack-signature") ?? "";
    const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";

    const valid = await slackAdapter.verifyRequest(
      signature,
      timestamp,
      rawBody,
    );
    if (!valid) {
      set.status = 401;
      return { error: "UNAUTHORIZED", message: "Invalid signature" };
    }

    const payload = JSON.parse(rawBody);

    if (payload.type === "url_verification") {
      return { challenge: payload.challenge };
    }

    if (payload.type === "event_callback" && payload.event) {
      if (payload.event_id && isDuplicateEvent(payload.event_id)) {
        log.debug(
          { eventId: payload.event_id },
          "Duplicate Slack event, skipping",
        );
        return { ok: true };
      }

      const event = payload.event;

      const isDm =
        event.type === "message" &&
        event.channel_type === "im" &&
        !event.bot_id &&
        !event.subtype;

      if (event.type === "app_mention" || isDm) {
        if (event.bot_id) {
          return { ok: true };
        }

        log.info(
          { channel: event.channel, user: event.user, dm: isDm },
          isDm ? "Received Slack DM" : "Received Slack mention",
        );

        // DMs are fire-and-forget: always use event.ts so each message
        // gets a unique threadKey (no thread continuation).
        const threadTs = isDm ? event.ts : (event.thread_ts ?? event.ts);

        setImmediate(() => {
          integrationGateway
            .handleEvent({
              source: "slack",
              threadKey: SlackAdapter.buildThreadKey(event.channel, threadTs),
              user: event.user,
              text: event.text ?? "",
              isDirectMessage: isDm || undefined,
              raw: {
                channel: event.channel,
                ts: event.ts,
                threadTs,
                channelType: event.channel_type,
                teamId: payload.team_id,
              },
            })
            .catch((err: unknown) => {
              log.error({ error: err }, "Integration event handler failed");
            });
        });

        return { ok: true };
      }
    }

    return { ok: true };
  })
  .post("/github/events", async ({ request, set }) => {
    if (!isGitHubEnabled() || !githubAdapter) {
      set.status = 404;
      return { error: "NOT_FOUND", message: "GitHub integration disabled" };
    }

    const rawBody = await request.clone().text();
    const signature = request.headers.get("x-hub-signature-256") ?? "";
    const deliveryId = request.headers.get("x-github-delivery") ?? "";
    const eventType = request.headers.get("x-github-event") ?? "";

    const valid = await githubAdapter.verifyWebhook(signature, rawBody);
    if (!valid) {
      set.status = 401;
      return { error: "UNAUTHORIZED", message: "Invalid signature" };
    }

    if (deliveryId && isDuplicateEvent(deliveryId)) {
      log.debug({ deliveryId }, "Duplicate GitHub event, skipping");
      return { ok: true };
    }

    const payload = JSON.parse(rawBody);

    if (eventType === "ping") {
      log.info("GitHub webhook ping received");
      return { ok: true };
    }

    const sender = payload.sender;
    if (sender?.type === "Bot" || sender?.login?.endsWith("[bot]")) {
      return { ok: true };
    }

    const association = payload.comment?.author_association ?? "";
    if (!ALLOWED_ASSOCIATIONS.has(association)) {
      log.debug(
        { association, user: sender?.login },
        "Ignoring GitHub event from non-collaborator",
      );
      return { ok: true };
    }

    const comment = payload.comment;
    if (!comment?.body) {
      return { ok: true };
    }

    const botLogin = "atelier";
    const mentionPattern = new RegExp(`@${botLogin}\\b`, "i");
    if (!mentionPattern.test(comment.body)) {
      return { ok: true };
    }

    const owner = payload.repository?.owner?.login ?? "";
    const repo = payload.repository?.name ?? "";
    const text = stripMentionTag(comment.body, botLogin);

    if (eventType === "issue_comment") {
      const issue = payload.issue;
      const isPr = !!issue?.pull_request;
      const number = issue?.number ?? 0;
      const contextType = isPr ? "pr" : "issue";

      log.info(
        {
          owner,
          repo,
          number,
          contextType,
          user: sender?.login,
        },
        "Received GitHub issue_comment mention",
      );

      setImmediate(() => {
        integrationGateway
          .handleEvent({
            source: "github",
            threadKey: GitHubAdapter.buildThreadKey(owner, repo, number),
            user: sender?.login ?? "unknown",
            text,
            raw: {
              owner,
              repo,
              number,
              commentId: comment.id,
              contextType,
              headBranch: isPr ? issue.pull_request?.head?.ref : undefined,
              baseBranch: isPr ? issue.pull_request?.base?.ref : undefined,
            },
          })
          .catch((err: unknown) => {
            log.error(
              { error: err },
              "GitHub integration event handler failed",
            );
          });
      });

      return { ok: true };
    }

    if (eventType === "pull_request_review_comment") {
      const pr = payload.pull_request;
      const number = pr?.number ?? 0;

      log.info(
        { owner, repo, number, user: sender?.login },
        "Received GitHub PR review comment mention",
      );

      setImmediate(() => {
        integrationGateway
          .handleEvent({
            source: "github",
            threadKey: GitHubAdapter.buildThreadKey(owner, repo, number),
            user: sender?.login ?? "unknown",
            text,
            raw: {
              owner,
              repo,
              number,
              commentId: comment.id,
              contextType: "pr_review" as const,
              headBranch: pr?.head?.ref,
              baseBranch: pr?.base?.ref,
              diffHunk: comment.diff_hunk,
              path: comment.path,
              line: comment.line ?? comment.original_line,
            },
          })
          .catch((err: unknown) => {
            log.error(
              { error: err },
              "GitHub PR review comment handler failed",
            );
          });
      });

      return { ok: true };
    }

    if (eventType === "discussion_comment") {
      const discussion = payload.discussion;
      const number = discussion?.number ?? 0;

      log.info(
        { owner, repo, number, user: sender?.login },
        "Received GitHub discussion comment mention",
      );

      setImmediate(() => {
        integrationGateway
          .handleEvent({
            source: "github",
            threadKey: GitHubAdapter.buildThreadKey(
              owner,
              repo,
              number,
              "discussion",
            ),
            user: sender?.login ?? "unknown",
            text,
            raw: {
              owner,
              repo,
              number,
              commentId: comment.id,
              contextType: "discussion" as const,
              discussionNodeId: discussion?.node_id,
              commentNodeId: comment?.node_id,
            },
          })
          .catch((err: unknown) => {
            log.error(
              { error: err },
              "GitHub discussion comment handler failed",
            );
          });
      });

      return { ok: true };
    }

    return { ok: true };
  });
