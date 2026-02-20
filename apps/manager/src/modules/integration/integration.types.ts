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

export interface IntegrationLink {
  url: string;
  content?: string;
}

export interface IntegrationContext {
  messages: IntegrationMessage[];
  links: IntegrationLink[];
  currentRequest: {
    user: string;
    text: string;
  };
}

export interface IntegrationAdapter {
  readonly source: IntegrationSource;

  extractContext(event: IntegrationEvent): Promise<IntegrationContext>;
  formatContextForPrompt(context: IntegrationContext): string;

  addReaction(event: IntegrationEvent, emoji: string): Promise<void>;
  removeReaction(event: IntegrationEvent, emoji: string): Promise<void>;

  postMessage(event: IntegrationEvent, text: string): Promise<void>;
  formatCompletionMessage(taskTitle: string, description: string): string;
}

/* ------------------------------------------------------------------ */
/*  Context extracted from the conversation / PR                      */
/* ------------------------------------------------------------------ */

export interface IntegrationMessage {
  user: string;
  text: string;
  timestamp?: string;
}

export interface IntegrationLink {
  url: string;
  content?: string;
}

export interface IntegrationContext {
  messages: IntegrationMessage[];
  links: IntegrationLink[];
  currentRequest: {
    user: string;
    text: string;
  };
}

/* ------------------------------------------------------------------ */
/*  Adapter contract                                                   */
/* ------------------------------------------------------------------ */

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

  /**
   * Build a structured completion summary for the platform.
   * Called by the gateway safety-net when the task finishes.
   */
  formatCompletionMessage(taskTitle: string, description: string): string;
}
