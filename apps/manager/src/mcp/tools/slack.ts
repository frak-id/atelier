import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebClient } from "@slack/web-api";
import { z } from "zod/v4";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("mcp-slack-tools");

function getClient(): WebClient {
  return new WebClient(config.integrations.slack.botToken);
}

export function registerSlackTools(server: McpServer): void {
  server.registerTool(
    "slack_get_thread",
    {
      title: "Get Slack Thread",
      description:
        "Fetch messages from a Slack thread. Returns all messages " +
        "in the thread including the parent message. Use this to " +
        "read conversation context before taking action.",
      inputSchema: z.object({
        channel: z.string().describe("The Slack channel ID"),
        threadTs: z
          .string()
          .describe("The thread timestamp (thread_ts) to fetch replies for"),
        limit: z
          .number()
          .optional()
          .describe("Max messages to fetch (default 50, max 200)"),
      }),
    },
    async ({ channel, threadTs, limit }) => {
      if (!config.integrations.slack.botToken) {
        return {
          content: [
            { type: "text", text: "Slack integration is not configured" },
          ],
          isError: true,
        };
      }

      try {
        const client = getClient();
        const result = await client.conversations.replies({
          channel,
          ts: threadTs,
          inclusive: true,
          limit: Math.min(limit ?? 50, 200),
        });

        const messages = (result.messages ?? []).map((msg) => ({
          user: msg.user ?? msg.bot_id ?? "unknown",
          text: msg.text ?? "",
          ts: msg.ts,
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error({ channel, threadTs, error: msg }, "Failed to fetch thread");
        return {
          content: [{ type: "text", text: `Failed to fetch thread: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "slack_post_message",
    {
      title: "Post Slack Message",
      description:
        "Post a message to a Slack channel, optionally in a thread. " +
        "Use this to reply to users in Slack conversations.",
      inputSchema: z.object({
        channel: z.string().describe("The Slack channel ID to post in"),
        text: z.string().describe("The message text (supports Slack mrkdwn)"),
        threadTs: z
          .string()
          .optional()
          .describe(
            "Thread timestamp to reply in. If provided, " +
              "the message is posted as a thread reply",
          ),
      }),
    },
    async ({ channel, text, threadTs }) => {
      if (!config.integrations.slack.botToken) {
        return {
          content: [
            { type: "text", text: "Slack integration is not configured" },
          ],
          isError: true,
        };
      }

      try {
        const client = getClient();
        const result = await client.chat.postMessage({
          channel,
          text,
          ...(threadTs && { thread_ts: threadTs }),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: result.ok, ts: result.ts, channel: result.channel },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error({ channel, error: msg }, "Failed to post message");
        return {
          content: [{ type: "text", text: `Failed to post message: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
