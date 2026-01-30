import { App } from "@slack/bolt";
import type { SlackConfig } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { ConfigFileService } from "../config-file/index.ts";
import type { SlackThreadService } from "../slack-thread/index.ts";
import type { WorkspaceService } from "../workspace/index.ts";

interface MentionEvent {
  thread_ts?: string;
  ts: string;
  channel: string;
  user?: string;
  text?: string;
}

interface SlackWebClient {
  chat: {
    postMessage(args: {
      channel: string;
      thread_ts?: string;
      text: string;
    }): Promise<unknown>;
  };
  conversations: {
    replies(args: { channel: string; ts: string }): Promise<{
      messages?: Array<{ bot_id?: string; text?: string }>;
    }>;
  };
}

const log = createChildLogger("slack-bot");

const SLACK_CONFIG_PATH = "slack-config";
const MAX_ACTIVE_PER_WORKSPACE = 3;

interface SlackBotDependencies {
  slackThreadService: SlackThreadService;
  workspaceService: WorkspaceService;
  configFileService: ConfigFileService;
}

export class SlackBotService {
  private app: App | null = null;
  private connected = false;

  constructor(private readonly deps: SlackBotDependencies) {}

  async start(): Promise<void> {
    const slackConfig = this.getConfig();
    if (!slackConfig) {
      log.info("Slack bot not configured, skipping");
      return;
    }

    try {
      this.app = new App({
        token: slackConfig.botToken,
        signingSecret: slackConfig.signingSecret,
        socketMode: true,
        appToken: slackConfig.appToken,
      });

      this.app.event("app_mention", async ({ event, client }) => {
        await this.handleAppMention(event, client);
      });

      await this.app.start();
      this.connected = true;
      log.info("Slack bot connected via Socket Mode");
    } catch (error) {
      log.error({ error }, "Failed to start Slack bot");
      this.connected = false;
    }
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.connected = false;
      log.info("Slack bot disconnected");
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getActiveThreadCount(): number {
    return this.deps.slackThreadService.getActive().length;
  }

  getSlackWebClient(): SlackWebClient | null {
    return this.app?.client ?? null;
  }

  private getConfig(): SlackConfig | null {
    try {
      const configFile = this.deps.configFileService.getByPath(
        SLACK_CONFIG_PATH,
        "global",
      );
      if (!configFile) return null;

      const parsed = JSON.parse(configFile.content) as SlackConfig;
      if (!parsed.botToken || !parsed.appToken || !parsed.signingSecret) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async handleAppMention(
    event: MentionEvent,
    client: SlackWebClient,
  ): Promise<void> {
    const threadTs = event.thread_ts || event.ts;
    const channel = event.channel;
    const user = event.user ?? "unknown";
    const text = event.text ?? "";

    try {
      const existing = this.deps.slackThreadService.getByThreadKey(
        channel,
        threadTs,
      );

      if (existing) {
        if (existing.status === "active") {
          await this.handleFollowUp(existing, text, client);
        } else if (existing.status === "spawning") {
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: "⏳ Still setting up, please wait...",
          });
        }
        return;
      }

      await this.handleNewThread(channel, user, text, client, threadTs);
    } catch (error) {
      log.error({ error, channel, threadTs }, "Error handling app_mention");
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "❌ Something went wrong. Please try again.",
      });
    }
  }

  private async handleNewThread(
    channel: string,
    user: string,
    text: string,
    client: SlackWebClient,
    threadTs: string,
  ): Promise<void> {
    const workspaces = this.deps.workspaceService.getAll();
    const cleanedText = text
      .replace(/<@[A-Z0-9]+>/gi, "")
      .trim()
      .toLowerCase();

    const workspace = workspaces.find((ws) =>
      cleanedText.includes(ws.name.toLowerCase()),
    );

    if (!workspace) {
      const names = workspaces.map((ws) => ws.name).join(", ");
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Couldn't find a matching workspace. Available: ${names}`,
      });
      return;
    }

    const activeCount = this.deps.slackThreadService.countActiveByWorkspaceId(
      workspace.id,
    );
    if (activeCount >= MAX_ACTIVE_PER_WORKSPACE) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `⚠️ Workspace *${workspace.name}* already has ${activeCount} active threads. Please wait for one to finish.`,
      });
      return;
    }

    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `⏳ Spawning sandbox for *${workspace.name}*...`,
    });

    const replies = await client.conversations.replies({
      channel,
      ts: threadTs,
    });

    const userMessages = (replies.messages ?? [])
      .filter(
        (msg: { bot_id?: string; text?: string }) => !msg.bot_id && msg.text,
      )
      .map((msg: { text?: string }) => msg.text as string)
      .join("\n");

    const initialMessage = userMessages || text;

    const thread = this.deps.slackThreadService.create({
      workspaceId: workspace.id,
      channelId: channel,
      threadTs,
      userId: user,
      initialMessage,
    });

    this.deps.slackThreadService.markSpawning(thread.id);

    log.info(
      { threadId: thread.id, workspaceId: workspace.id },
      "Slack thread created, awaiting spawner wiring",
    );
  }

  private async handleFollowUp(
    thread: {
      id: string;
      sandboxId?: string | null;
      sessionId?: string | null;
    },
    text: string,
    _client: SlackWebClient,
  ): Promise<void> {
    if (!thread.sandboxId || !thread.sessionId) {
      return;
    }

    log.info(
      { threadId: thread.id, text },
      "Follow-up message in Slack thread",
    );
  }
}
