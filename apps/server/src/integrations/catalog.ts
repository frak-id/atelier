/**
 * The integrations compiled into this server. Adding one is an import and an
 * entry here; it stays off until the operator sets
 * `ATELIER_INTEGRATION_<ID>=true`. This is the only file outside a vendor
 * directory that may import one (check:boundary).
 */
import type { Integration } from "./integration.ts";
import { steeryIntegration } from "./steery/index.ts";

export const INTEGRATIONS: readonly Integration[] = [steeryIntegration];
