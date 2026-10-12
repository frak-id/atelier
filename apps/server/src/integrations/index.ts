/**
 * The integrations module's public interface (see `integration.ts`). The
 * server wires it in `api/container.ts`.
 */
export { INTEGRATIONS } from "./catalog.ts";
export { IntegrationHub } from "./hub.ts";
export type { Integration, IntegrationManifest } from "./integration.ts";
export {
  createIntegrationRegistry,
  type IntegrationRegistry,
} from "./registry.ts";
