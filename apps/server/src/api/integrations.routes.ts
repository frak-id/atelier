/**
 * `/api/integrations` — Settings → Integrations. Lists the integrations the
 * operator enabled with the caller's own connection, and connects and
 * disconnects them.
 */
import {
  IntegrationConnectionInputSchema,
  IntegrationConnectionViewSchema,
  type IntegrationView,
  IntegrationViewSchema,
} from "@frak/atelier-shared";
import { Elysia, t } from "elysia";
import type {
  Integration,
  IntegrationManifest,
} from "../integrations/index.ts";
import { NotFoundError, ValidationError } from "../shared/errors.ts";
import { createAuthPlugin } from "./auth.plugin.ts";
import type { ServerContainer } from "./container.ts";

/** The manifest fields the console shows. */
function manifestView(manifest: IntegrationManifest) {
  const { id, label, description, docsUrl, credential } = manifest;
  return { id, label, description, docsUrl, credential };
}

export function createIntegrationsRoutes(container: ServerContainer) {
  const { control, integrations } = container;
  const { integrationConnectionService: connections } = control;
  const authPlugin = createAuthPlugin(control);

  const enabledIntegration = (id: string): Integration => {
    const integration = integrations.get(id);
    if (!integration) throw new NotFoundError("Integration", id);
    return integration;
  };

  const connectionView = (
    connection: NonNullable<ReturnType<typeof connections.get>>,
  ): NonNullable<IntegrationView["connection"]> => ({
    enabled: connection.enabled,
    minRisk: connection.minRisk,
    delaySeconds: connection.delaySeconds,
    hasCredential: connection.hasCredential,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  });

  const view = (userId: string, integration: Integration): IntegrationView => ({
    ...manifestView(integration.manifest),
    capabilities: {
      permissions: typeof integration.onPermission === "function",
    },
    connection: ((c) => (c ? connectionView(c) : null))(
      connections.get(userId, integration.manifest.id),
    ),
  });

  return (
    new Elysia({ prefix: "/api/integrations" })
      .use(authPlugin)
      .get(
        "/",
        ({ user }) =>
          integrations
            .enabled()
            .map((integration) => view(user.id, integration)),
        { response: t.Array(IntegrationViewSchema) },
      )
      .put(
        "/:id/connection",
        async ({ user, params, body }) => {
          const integration = enabledIntegration(params.id);
          const { credential } = integration.manifest;
          if (body.credential != null && !credential) {
            throw new ValidationError(
              `${integration.manifest.label} takes no credential`,
            );
          }
          const existing = connections.get(user.id, params.id);
          const willHaveCredential =
            body.credential === undefined
              ? (existing?.hasCredential ?? false)
              : body.credential !== null;
          if (credential?.required && !willHaveCredential) {
            throw new ValidationError(`${credential.label} is required`);
          }
          return connectionView(
            await connections.upsert(user.id, params.id, body),
          );
        },
        {
          body: IntegrationConnectionInputSchema,
          response: IntegrationConnectionViewSchema,
        },
      )
      // Any catalog id, even a disabled one, so leftovers can be cleaned up.
      .delete("/:id/connection", ({ user, params, set }) => {
        if (!integrations.isKnown(params.id)) {
          throw new NotFoundError("Integration", params.id);
        }
        connections.delete(user.id, params.id);
        set.status = 204;
      })
  );
}
