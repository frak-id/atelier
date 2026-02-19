import { Elysia } from "elysia";
import { slackService } from "../container.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("slack-routes");

export const slackRoutes = new Elysia({ prefix: "/slack" }).post(
  "/events",
  async ({ request, set }) => {
    if (!slackService.isEnabled()) {
      set.status = 404;
      return { error: "NOT_FOUND", message: "Slack integration disabled" };
    }

    const rawBody = await request.clone().text();

    const signature = request.headers.get("x-slack-signature") ?? "";
    const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";

    const valid = await slackService.verifyRequest(
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
      const event = payload.event;

      if (event.type === "app_mention") {
        if (event.bot_id) {
          return { ok: true };
        }

        log.info(
          { channel: event.channel, user: event.user },
          "Received Slack mention",
        );

        setImmediate(() => {
          slackService.handleMention(event).catch((err: unknown) => {
            log.error({ error: err }, "Slack mention handler failed");
          });
        });

        return { ok: true };
      }
    }

    return { ok: true };
  },
);
