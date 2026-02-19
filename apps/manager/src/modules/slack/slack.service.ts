import { WebClient } from "@slack/web-api";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { SystemSandboxService } from "../system-sandbox/index.ts";
import type { WorkspaceService } from "../workspace/index.ts";

const log = createChildLogger("slack");

const URL_REGEX = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g;
const PLAIN_URL_REGEX = /(?<![<|])https?:\/\/[^\s<>|]+/g;

interface SlackMessage {
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

export interface SlackMentionEvent {
  type: string;
  user: string;
  text: string;
  ts: string;
  channel: string;
  thread_ts?: string;
}

interface SlackServiceDependencies {
  systemSandboxService: SystemSandboxService;
  workspaceService: WorkspaceService;
}

export class SlackService {
  private client: WebClient;

  constructor(private readonly deps: SlackServiceDependencies) {
    this.client = new WebClient(config.integrations.slack.botToken);
  }

  isEnabled(): boolean {
    const { enabled, botToken, signingSecret } = config.integrations.slack;
    return enabled && !!botToken && !!signingSecret;
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
      log.warn("Slack request timestamp too old, possible replay attack");
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

  async handleMention(event: SlackMentionEvent): Promise<void> {
    const { channel, ts, thread_ts, user } = event;
    const threadTs = thread_ts ?? ts;

    log.info({ channel, threadTs, user }, "Processing Slack mention");

    const messages = await this.extractThreadContext(channel, threadTs);
    const links = this.extractLinks(messages);
    const linkContents = await this.fetchLinkContent(links);
    const context = this.buildContext(messages, links, linkContents, event);

    await this.sendToAi(context, channel, threadTs);
  }

  private async extractThreadContext(
    channel: string,
    threadTs: string,
  ): Promise<SlackMessage[]> {
    try {
      const result = await this.client.conversations.replies({
        channel,
        ts: threadTs,
        inclusive: true,
        limit: 50,
      });
      return (result.messages as SlackMessage[]) ?? [];
    } catch (error) {
      log.warn(
        { channel, threadTs, error },
        "Failed to fetch thread, using single message",
      );
      return [];
    }
  }

  private extractLinks(messages: SlackMessage[]): string[] {
    const links = new Set<string>();
    for (const msg of messages) {
      if (!msg.text) continue;

      for (const match of msg.text.matchAll(URL_REGEX)) {
        if (match[1]) links.add(match[1]);
      }

      for (const match of msg.text.matchAll(PLAIN_URL_REGEX)) {
        if (match[0]) links.add(match[0]);
      }
    }
    return [...links];
  }

  private async fetchLinkContent(urls: string[]): Promise<Map<string, string>> {
    const contents = new Map<string, string>();
    const fetches = urls.slice(0, 5).map(async (url) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "AtelierBot/1.0" },
        });
        clearTimeout(timeout);

        if (!response.ok) return;

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text") && !contentType.includes("json")) {
          return;
        }

        const text = await response.text();
        contents.set(url, text.slice(0, 3000));
      } catch {
        log.debug({ url }, "Failed to fetch link content");
      }
    });

    await Promise.allSettled(fetches);
    return contents;
  }

  private buildContext(
    messages: SlackMessage[],
    links: string[],
    linkContents: Map<string, string>,
    mentionEvent: SlackMentionEvent,
  ): string {
    let ctx = "# Slack Conversation Context\n\n";

    if (messages.length > 0) {
      ctx += "## Thread Messages\n\n";
      for (const msg of messages) {
        const userLabel = msg.user ? `<@${msg.user}>` : "unknown";
        const text = msg.text ?? "(empty)";
        ctx += `**${userLabel}**: ${text}\n\n`;
      }
    }

    if (links.length > 0) {
      ctx += "## Links Referenced\n\n";
      for (const link of links) {
        const content = linkContents.get(link);
        if (content) {
          ctx += `### ${link}\n\n\`\`\`\n${content}\n\`\`\`\n\n`;
        } else {
          ctx += `- ${link}\n`;
        }
      }
      ctx += "\n";
    }

    ctx += "## Current Request\n\n";
    ctx += `**From:** <@${mentionEvent.user}>\n`;
    ctx += `**Message:** ${mentionEvent.text}\n`;

    return ctx;
  }

  private async sendToAi(
    context: string,
    channel: string,
    threadTs: string,
  ): Promise<void> {
    const workspaces = this.deps.workspaceService.getAll();
    const workspaceList = workspaces
      .map((w) => `- **${w.name}** (id: \`${w.id}\`)`)
      .join("\n");

    const masterPrompt = [
      "You are the Atelier Slack bot. Someone mentioned you in a Slack conversation.",
      "You have access to atelier-mcp tools to manage workspaces and tasks,",
      "and Slack tools to read threads and post messages.",
      "",
      `**Slack channel:** \`${channel}\``,
      `**Thread timestamp:** \`${threadTs}\``,
      "",
      "Available workspaces:",
      workspaceList || "- (no workspaces configured)",
      "",
      "Based on the conversation context below, decide what to do:",
      "",
      "- If the user is requesting implementation, review, fix, or any coding work:",
      "  1. Pick the most appropriate workspace",
      "  2. Use `create_task` with `autoStart: true` to create and start the task",
      "  3. Use `slack_post_message` to reply in the thread confirming what you did",
      "",
      "- If it's a question you can answer or doesn't require a task:",
      "  1. Use `slack_post_message` to reply in the thread with your answer",
      "",
      "Always reply in the Slack thread so the user knows you handled their request.",
      "",
      "---",
      "",
      context,
    ].join("\n");

    const { client } = await this.deps.systemSandboxService.acquire();
    try {
      const { data: session, error: createError } =
        await client.session.create();
      if (createError || !session?.id) {
        throw new Error("Failed to create OpenCode session for Slack mention");
      }

      try {
        const { error: promptError } = await client.session.promptAsync({
          sessionID: session.id,
          parts: [{ type: "text", text: masterPrompt }],
        });

        if (promptError) {
          throw new Error("Slack AI prompt failed");
        }

        log.info({ channel, threadTs }, "Slack mention dispatched to AI");
      } finally {
        await client.session.delete({ sessionID: session.id }).catch(() => {});
      }
    } finally {
      this.deps.systemSandboxService.release();
    }
  }
}
