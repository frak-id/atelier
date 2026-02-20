import { Elysia } from "elysia";
import { integrationGateway, slackAdapter } from "../container.ts";
import { SlackAdapter } from "../modules/integration/adapters/slack.adapter.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("integration-routes");

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
    const event = payload.event;

    if (event.type === "app_mention") {
      if (event.bot_id) {
        return { ok: true };
      }

      log.info(
        { channel: event.channel, user: event.user },
        "Received Slack mention",
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
