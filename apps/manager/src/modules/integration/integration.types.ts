export const INTEGRATION_SOURCES = ["slack", "github"] as const;
export type IntegrationSource = (typeof INTEGRATION_SOURCES)[number];

export interface IntegrationEvent {
  source: IntegrationSource;
  /**
   * Unique key for the conversation thread.
   * Slack: `${channel}:${threadTs}` — GitHub: `${owner}/${repo}:${prNumber}`
   */
  threadKey: string;
  user: string;
  text: string;
  /** Platform-specific payload, only accessed by the matching adapter. */
  raw: unknown;
}

export interface IntegrationMessage {
  user: string;
  text: string;
  timestamp?: string;
}

export interface IntegrationContext {
  messages: IntegrationMessage[];
  currentRequest: {
    user: string;
    text: string;
  };
  /** Indicates this is a direct message (Slack DM / im channel). */
  isDirectMessage?: boolean;
}

/* — Progress tracking types — */

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface AttentionItem {
  type: "permission" | "question";
  description: string;
  url: string;
}

export interface ProgressState {
  status: "starting" | "running" | "attention" | "completed";
  sandboxId: string;
  urls: {
    dashboard: string;
    opencode: string;
  };
  startedAt: string;
  completedAt?: string;
  duration?: string;
  todos: TodoItem[];
  currentTask?: string;
  attention?: AttentionItem;
}

export interface IntegrationAdapter {
  readonly source: IntegrationSource;

  /**
   * Pull the full conversation / PR context for this event.
   * Called once per gateway dispatch.
   */
  extractContext(event: IntegrationEvent): Promise<IntegrationContext>;

  /**
   * Render an `IntegrationContext` as a markdown string suitable
   * for an LLM prompt.
   */
  formatContextForPrompt(context: IntegrationContext): string;

  /* — Feedback — */

  /** Show a "working on it" indicator (e.g. emoji reaction). */
  addReaction(event: IntegrationEvent, emoji: string): Promise<void>;

  /** Remove the indicator when work is done. */
  removeReaction(event: IntegrationEvent, emoji: string): Promise<void>;

  /* — Communication — */

  /** Post a message in the originating thread / PR comment. */
  postMessage(event: IntegrationEvent, text: string): Promise<void>;

  /* — Progress tracking — */

  /**
   * Post a progress tracking message (Block Kit on Slack, rich comment
   * on GitHub, etc.).  Returns a platform message ID for future updates.
   */
  postProgressMessage?(
    event: IntegrationEvent,
    state: ProgressState,
  ): Promise<string | undefined>;

  /**
   * Update a previously posted progress message in-place.
   */
  updateProgressMessage?(
    event: IntegrationEvent,
    messageId: string,
    state: ProgressState,
  ): Promise<void>;
}
