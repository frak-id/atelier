import type { KnownBlock } from "@slack/web-api";
import { WebClient } from "@slack/web-api";
import { config } from "../../../shared/lib/config.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type {
  IntegrationAdapter,
  IntegrationContext,
  IntegrationEvent,
  IntegrationMessage,
  ProgressState,
  TodoItem,
} from "../integration.types.ts";

const log = createChildLogger("slack-adapter");

const THREAD_FETCH_LIMIT = 50;

interface SlackRawEvent {
  channel: string;
  ts: string;
  threadTs: string;
  channelType?: string;
}

interface SlackMessage {
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
}

export class SlackAdapter implements IntegrationAdapter {
  readonly source = "slack" as const;
  private client: WebClient;

  constructor() {
    this.client = new WebClient(config.integrations.slack.botToken);
  }

  static buildThreadKey(channel: string, threadTs: string): string {
    return `${channel}:${threadTs}`;
  }

  static parseThreadKey(threadKey: string): {
    channel: string;
    threadTs: string;
  } {
    const idx = threadKey.indexOf(":");
    return {
      channel: threadKey.slice(0, idx),
      threadTs: threadKey.slice(idx + 1),
    };
  }

  async extractContext(event: IntegrationEvent): Promise<IntegrationContext> {
    const { channel, threadTs } = SlackAdapter.parseThreadKey(event.externalId);
    const raw = event.raw as SlackRawEvent;
    const isDirectMessage = raw.channelType === "im";

    // Skip thread history for DMs to avoid fetching entire DM conversation
    const rawMessages = isDirectMessage
      ? []
      : await this.fetchThread(channel, threadTs);

    const messages: IntegrationMessage[] = rawMessages.map((m) => ({
      user: m.user ?? m.bot_id ?? "unknown",
      text: m.text ?? "",
      timestamp: m.ts,
    }));

    return {
      messages,
      currentRequest: { user: event.user, text: event.text },
      isDirectMessage,
    };
  }

  formatContextForPrompt(context: IntegrationContext): string {
    let md = "# Conversation Context\n\n";

    if (context.isDirectMessage) {
      md +=
        "_Note: This is a direct message. Post progress updates to the same message; do not send additional messages._\n\n";
    }

    if (context.messages.length > 0) {
      md += "## Thread Messages\n\n";
      for (const msg of context.messages) {
        md += `**<@${msg.user}>**: ${msg.text}\n\n`;
      }
    }

    md += "## Current Request\n\n";
    md += `**From:** <@${context.currentRequest.user}>\n`;
    md += `**Message:** ${context.currentRequest.text}\n`;

    return md;
  }

  async addReaction(event: IntegrationEvent, emoji: string): Promise<void> {
    const raw = event.raw as SlackRawEvent;
    try {
      await this.client.reactions.add({
        channel: raw.channel,
        timestamp: raw.ts,
        name: emoji,
      });
    } catch (error) {
      log.debug({ error, emoji }, "Failed to add reaction");
    }
  }

  async removeReaction(event: IntegrationEvent, emoji: string): Promise<void> {
    const raw = event.raw as SlackRawEvent;
    try {
      await this.client.reactions.remove({
        channel: raw.channel,
        timestamp: raw.ts,
        name: emoji,
      });
    } catch (error) {
      log.debug({ error, emoji }, "Failed to remove reaction");
    }
  }

  async postMessage(event: IntegrationEvent, text: string): Promise<void> {
    const { channel, threadTs } = SlackAdapter.parseThreadKey(event.externalId);
    log.debug(
      { channel, threadTs, externalId: event.externalId },
      "Posting message to thread",
    );
    const result = await this.client.chat.postMessage({
      channel,
      text,
      thread_ts: threadTs,
    });
    log.debug(
      { ok: result.ok, ts: result.ts, threadTs: result.message?.thread_ts },
      "Message posted",
    );
  }

  async postProgressMessage(
    event: IntegrationEvent,
    state: ProgressState,
  ): Promise<string | undefined> {
    const { channel, threadTs } = SlackAdapter.parseThreadKey(event.externalId);
    try {
      const result = await this.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: progressFallbackText(state),
        blocks: buildProgressBlocks(state),
      });
      return result.ts;
    } catch (error) {
      log.debug({ error }, "Failed to post progress message");
      return undefined;
    }
  }

  async updateProgressMessage(
    event: IntegrationEvent,
    messageId: string,
    state: ProgressState,
  ): Promise<void> {
    const { channel } = SlackAdapter.parseThreadKey(event.externalId);
    try {
      await this.client.chat.update({
        channel,
        ts: messageId,
        text: progressFallbackText(state),
        blocks: buildProgressBlocks(state),
      });
    } catch (error) {
      log.debug({ error }, "Failed to update progress message");
    }
  }

  async verifyRequest(
    signature: string,
    timestamp: string,
    rawBody: string,
  ): Promise<boolean> {
    const signingSecret = config.integrations.slack.signingSecret;
    if (!signingSecret) return false;

    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
    if (Number.parseInt(timestamp, 10) < fiveMinutesAgo) {
      log.warn("Request timestamp too old, possible replay attack");
      return false;
    }

    const sigBasestring = `v0:${timestamp}:${rawBody}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signatureBytes = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(sigBasestring),
    );
    const computed = `v0=${Array.from(new Uint8Array(signatureBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}`;

    return computed === signature;
  }

  private async fetchThread(
    channel: string,
    threadTs: string,
  ): Promise<SlackMessage[]> {
    try {
      const result = await this.client.conversations.replies({
        channel,
        ts: threadTs,
        inclusive: true,
        limit: THREAD_FETCH_LIMIT,
      });
      return (result.messages as SlackMessage[]) ?? [];
    } catch (error) {
      log.warn({ channel, threadTs, error }, "Failed to fetch thread");
      return [];
    }
  }
}

const MAX_DISPLAY_TODOS = 15;

const TODO_ICONS: Record<TodoItem["status"], string> = {
  completed: ":white_check_mark:",
  in_progress: ":arrows_counterclockwise:",
  pending: ":white_large_square:",
  cancelled: ":no_entry_sign:",
};

function buildProgressBlocks(state: ProgressState): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: progressHeader(state) },
  });

  const links = [
    `<${state.urls.dashboard}|:computer: Dashboard>`,
    `<${state.urls.opencode}|:brain: OpenCode>`,
  ].join("  ·  ");
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: links }],
  });

  if (state.attention) {
    const icon =
      state.attention.type === "permission" ? ":raised_hand:" : ":question:";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${icon} ${state.attention.description}\n<${state.attention.url}|Answer in Dashboard>`,
      },
    });
  }

  const activeTodos = state.todos.filter((t) => t.status !== "cancelled");
  if (activeTodos.length > 0) {
    const completed = activeTodos.filter(
      (t) => t.status === "completed",
    ).length;
    let todoText = `*Progress* (${completed}/${activeTodos.length})\n`;

    const visible = activeTodos.slice(0, MAX_DISPLAY_TODOS);
    for (const todo of visible) {
      todoText += `${TODO_ICONS[todo.status]} ${todo.content}\n`;
    }
    if (activeTodos.length > MAX_DISPLAY_TODOS) {
      todoText += `_…and ${activeTodos.length - MAX_DISPLAY_TODOS} more_`;
    }

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: todoText.trimEnd() },
    });
  }

  return blocks;
}

function progressHeader(state: ProgressState): string {
  switch (state.status) {
    case "completed": {
      const dur = state.duration ? ` — ${state.duration}` : "";
      return `:white_check_mark: *Agent finished*${dur}`;
    }
    case "attention":
      return ":warning: *Agent needs input*";
    case "running":
      return ":hourglass_flowing_sand: *Agent working*";
    default:
      return ":rocket: *Agent started*";
  }
}

function progressFallbackText(state: ProgressState): string {
  switch (state.status) {
    case "completed":
      return `Agent finished${state.duration ? ` — ${state.duration}` : ""}`;
    case "attention":
      return "Agent needs input";
    case "running":
      return "Agent working…";
    default:
      return "Agent started";
  }
}
