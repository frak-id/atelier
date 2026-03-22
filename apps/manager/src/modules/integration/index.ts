export {
  GitHubAdapter,
  type GitHubIntegrationContext,
  SlackAdapter,
} from "./adapters/index.ts";
export { IntegrationGateway } from "./integration.gateway.ts";
export type {
  IntegrationAdapter,
  IntegrationContext,
  IntegrationEvent,
  IntegrationMessage,
  IntegrationSource,
  ProgressState,
  TodoItem,
} from "./integration.types.ts";
export { INTEGRATION_SOURCES } from "./integration.types.ts";
export { IntegrationEventBridge } from "./integration-event-bridge.ts";
