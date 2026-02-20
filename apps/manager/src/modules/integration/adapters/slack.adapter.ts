import { WebClient } from "@slack/web-api";
import { config } from "../../../shared/lib/config.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type {
  IntegrationAdapter,
  IntegrationContext,
  IntegrationEvent,
  IntegrationMessage,
} from "../integration.types.ts";

const log = createChildLogger("slack-adapter");

const THREAD_FETCH_LIMIT = 50;

interface SlackRawEvent {
  channel: string;
  ts: string;
  threadTs: string;
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
    const { channel, threadTs } = SlackAdapter.parseThreadKey(event.threadKey);
    const rawMessages = await this.fetchThread(channel, threadTs);

    const messages: IntegrationMessage[] = rawMessages.map((m) => ({
      user: m.user ?? m.bot_id ?? "unknown",
      text: m.text ?? "",
      timestamp: m.ts,
    }));

    return {
      messages,
      currentRequest: { user: event.user, text: event.text },
    };
  }

  formatContextForPrompt(context: IntegrationContext): string {
    let md = "# Conversation Context\n\n";

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
    const { channel, threadTs } = SlackAdapter.parseThreadKey(event.threadKey);
    await this.client.chat.postMessage({
      channel,
      text,
      thread_ts: threadTs,
    });
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
