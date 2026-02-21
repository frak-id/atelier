import { Elysia } from "elysia";
import { integrationGateway, slackAdapter } from "../container.ts";
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

export const integrationRoutes = new Elysia({
  prefix: "/integrations",
}).post("/slack/events", async ({ request, set }) => {
  if (!isSlackEnabled() || !slackAdapter) {
    set.status = 404;
    return { error: "NOT_FOUND", message: "Slack integration disabled" };
  }

  const rawBody = await request.clone().text();

  const signature = request.headers.get("x-slack-signature") ?? "";
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";

  const valid = await slackAdapter.verifyRequest(signature, timestamp, rawBody);
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

      const threadTs = event.thread_ts ?? event.ts;

      setImmediate(() => {
        integrationGateway
          .handleEvent({
            source: "slack",
            threadKey: SlackAdapter.buildThreadKey(event.channel, threadTs),
            user: event.user,
            text: event.text ?? "",
            raw: {
              channel: event.channel,
              ts: event.ts,
              threadTs,
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
});
