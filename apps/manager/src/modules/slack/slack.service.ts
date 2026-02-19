import { WebClient } from "@slack/web-api";
import type { ManagerEvent } from "../../infrastructure/events/index.ts";
import type { TaskSpawner } from "../../orchestrators/task-spawner.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { SystemSandboxService } from "../system-sandbox/index.ts";
import type { TaskService } from "../task/index.ts";
import type { TitleService } from "../title/index.ts";
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

interface SlackMentionEvent {
  type: string;
  user: string;
  text: string;
  ts: string;
  channel: string;
  thread_ts?: string;
}

interface AiDecision {
  action: "create_task" | "reply";
  workspaceId?: string;
  title?: string;
  description?: string;
  message?: string;
  baseBranch?: string;
  workflowId?: string;
}

interface SlackServiceDependencies {
  systemSandboxService: SystemSandboxService;
  taskService: TaskService;
  taskSpawner: TaskSpawner;
  workspaceService: WorkspaceService;
  titleService: TitleService;
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

    try {
      const messages = await this.extractThreadContext(channel, threadTs);
      const links = this.extractLinks(messages);
      const linkContents = await this.fetchLinkContent(links);
      const prompt = this.buildPrompt(messages, links, linkContents, event);
      const decision = await this.decideAction(prompt);

      if (decision.action === "create_task" && decision.workspaceId) {
        await this.createTask(decision, channel, threadTs, user);
      } else if (decision.message) {
        await this.postReply(channel, threadTs, decision.message);
      } else {
        await this.postReply(
          channel,
          threadTs,
          "I looked at the conversation but couldn't determine an action to take. Could you be more specific about what you'd like me to do?",
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ channel, threadTs, error: msg }, "Failed to handle mention");
      await this.postReply(
        channel,
        threadTs,
        `Something went wrong while processing your request: ${msg}`,
      ).catch(() => {});
    }
  }

  async onTaskEvent(event: ManagerEvent): Promise<void> {
    if (event.type !== "task.updated") return;

    const task = this.deps.taskService.getById(event.properties.id);
    if (!task) return;

    const integration = task.data.integration;
    if (!integration?.slack || integration.source !== "slack") return;

    if (task.status !== "done") return;

    const { channel, threadTs } = integration.slack;
    const branch = task.data.branchName;

    const message = branch
      ? `Task *${task.title}* is complete — ready for review on branch \`${branch}\``
      : `Task *${task.title}* is complete`;

    log.info(
      { taskId: task.id, channel, threadTs },
      "Notifying Slack of task completion",
    );
    await this.postReply(channel, threadTs, message).catch((error) => {
      log.error(
        { taskId: task.id, error },
        "Failed to post task completion to Slack",
      );
    });
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

  private buildPrompt(
    messages: SlackMessage[],
    links: string[],
    linkContents: Map<string, string>,
    mentionEvent: SlackMentionEvent,
  ): string {
    let prompt = "# Slack Conversation Context\n\n";

    if (messages.length > 0) {
      prompt += "## Thread Messages\n\n";
      for (const msg of messages) {
        const userLabel = msg.user ? `<@${msg.user}>` : "unknown";
        const text = msg.text ?? "(empty)";
        prompt += `**${userLabel}**: ${text}\n\n`;
      }
    }

    if (links.length > 0) {
      prompt += "## Links Referenced\n\n";
      for (const link of links) {
        const content = linkContents.get(link);
        if (content) {
          prompt += `### ${link}\n\n\`\`\`\n${content}\n\`\`\`\n\n`;
        } else {
          prompt += `- ${link}\n`;
        }
      }
      prompt += "\n";
    }

    prompt += "## Current Request\n\n";
    prompt += `**From:** <@${mentionEvent.user}>\n`;
    prompt += `**Message:** ${mentionEvent.text}\n`;

    return prompt;
  }

  private async decideAction(prompt: string): Promise<AiDecision> {
    const workspaces = this.deps.workspaceService.getAll();
    const workspaceList = workspaces
      .map((w) => `- **${w.name}** (id: \`${w.id}\`)`)
      .join("\n");

    const systemPrompt = [
      "You are the Atelier Slack bot.",
      "You receive Slack conversations where someone mentioned you.",
      "Your job is to decide if the user wants you to create a coding task.",
      "",
      "Available workspaces:",
      workspaceList || "- (no workspaces configured)",
      "",
      "Rules:",
      "- If the user is requesting implementation, review, fix, or any coding work: create a task",
      "- If the user is just chatting or asking a question you can answer directly: reply",
      "- Pick the most appropriate workspace based on the context",
      "- Write a clear, detailed task description from the conversation context",
      "- Generate a concise task title",
      "",
      "Respond with ONLY a JSON object (no markdown, no code fences):",
      '{"action":"create_task","workspaceId":"...","title":"...","description":"..."}',
      "or",
      '{"action":"reply","message":"..."}',
    ].join("\n");

    const fullPrompt = `${systemPrompt}\n\n---\n\n${prompt}`;

    const { client } = await this.deps.systemSandboxService.acquire();
    try {
      const { data: session, error: createError } =
        await client.session.create();
      if (createError || !session?.id) {
        throw new Error("Failed to create OpenCode session for Slack decision");
      }

      try {
        const { data, error: promptError } = await client.session.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: fullPrompt }],
        });

        if (promptError || !data) {
          throw new Error("Slack decision prompt failed");
        }

        const textPart = data.parts.find((p) => p.type === "text");
        if (!textPart || textPart.type !== "text" || !textPart.text.trim()) {
          throw new Error("No text in Slack decision response");
        }

        return this.parseDecision(textPart.text);
      } finally {
        await client.session.delete({ sessionID: session.id }).catch(() => {});
      }
    } finally {
      this.deps.systemSandboxService.release();
    }
  }

  private parseDecision(raw: string): AiDecision {
    const cleaned = raw
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    try {
      const parsed = JSON.parse(cleaned) as AiDecision;
      if (parsed.action !== "create_task" && parsed.action !== "reply") {
        log.warn({ raw: cleaned }, "Unknown AI decision action");
        return { action: "reply", message: cleaned };
      }
      return parsed;
    } catch {
      log.warn({ raw: cleaned }, "Failed to parse AI decision as JSON");
      return { action: "reply", message: cleaned };
    }
  }

  private async createTask(
    decision: AiDecision,
    channel: string,
    threadTs: string,
    triggeredBy: string,
  ): Promise<void> {
    const workspaceId = decision.workspaceId;
    if (!workspaceId) return;

    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) {
      await this.postReply(
        channel,
        threadTs,
        `Workspace \`${workspaceId}\` not found. Available workspaces: ${this.deps.workspaceService
          .getAll()
          .map((w) => `\`${w.name}\``)
          .join(", ")}`,
      );
      return;
    }

    const title =
      decision.title?.trim() ||
      this.deps.titleService.fallbackTitle(
        decision.description ?? "Slack task",
      );

    const task = this.deps.taskService.create({
      workspaceId,
      description: decision.description ?? "Task from Slack",
      title,
      baseBranch: decision.baseBranch,
      workflowId: decision.workflowId,
    });

    this.deps.taskService.setIntegrationMetadata(task.id, {
      source: "slack",
      slack: { channel, threadTs, triggeredBy },
    });

    if (!decision.title?.trim()) {
      this.deps.titleService.generateTitleInBackground(
        decision.description ?? "Slack task",
        (generatedTitle) => {
          this.deps.taskService.updateTitle(task.id, generatedTitle);
          this.deps.taskSpawner
            .updateSessionTitles(task.id, generatedTitle)
            .catch(() => {});
        },
      );
    }

    try {
      await this.deps.taskService.startTask(task.id);
      this.deps.taskSpawner.runInBackground(task.id);

      log.info(
        { taskId: task.id, title, workspace: workspace.name },
        "Task created from Slack",
      );

      await this.postReply(
        channel,
        threadTs,
        `Task created: *${title}* (id: \`${task.id}\`) on workspace *${workspace.name}*\nI'll let you know when it's done.`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ taskId: task.id, error: msg }, "Failed to start Slack task");
      await this.postReply(
        channel,
        threadTs,
        `Task created but failed to start: ${msg}`,
      );
    }
  }

  private async postReply(
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<void> {
    await this.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
    });
  }
}
