export interface SystemModelRef {
  providerID: string;
  modelID: string;
}

export interface SystemModelConfig {
  /** Default model for all system sandbox actions */
  default: SystemModelRef | null;
  /** Model for generating short task/workspace titles */
  title: SystemModelRef | null;
  /** Model for generating workspace descriptions from repo analysis */
  description: SystemModelRef | null;
  /** Model for routing integration events (Slack/GitHub) to workspaces */
  dispatcher: SystemModelRef | null;
}

export type SystemModelAction = "title" | "description" | "dispatcher";

export const DEFAULT_SYSTEM_MODEL_CONFIG: SystemModelConfig = {
  default: null,
  title: null,
  description: null,
  dispatcher: null,
};
