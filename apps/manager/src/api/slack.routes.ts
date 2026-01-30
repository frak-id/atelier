import { Elysia, t } from "elysia";
import { configFileService } from "../container.ts";
import type {
  SlackConfig,
  SlackStatus,
  SlackThread,
  SlackThreadListResponse,
} from "../schemas/index.ts";
import {
  SlackConfigSchema,
  SlackStatusSchema,
  SlackThreadListResponseSchema,
  SlackThreadSchema,
} from "../schemas/index.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("slack-routes");

function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  const first4 = token.slice(0, 4);
  const last4 = token.slice(-4);
  return `${first4}****${last4}`;
}

export const slackRoutes = new Elysia({ prefix: "/slack" })
  .get(
    "/status",
    (): SlackStatus => {
      return {
        connected: false,
        activeThreads: 0,
      };
    },
    {
      response: SlackStatusSchema,
      detail: { tags: ["slack"] },
    },
  )
  .get(
    "/config",
    () => {
      try {
        const configFile = configFileService.getByPath(
          "slack-config",
          "global",
        );
        if (!configFile) {
          return {
            botToken: "",
            appToken: "",
            signingSecret: "",
          };
        }

        const config = JSON.parse(configFile.content) as SlackConfig;
        return {
          botToken: maskToken(config.botToken || ""),
          appToken: maskToken(config.appToken || ""),
          signingSecret: maskToken(config.signingSecret || ""),
        };
      } catch (error) {
        log.debug({ error }, "Failed to read Slack config");
        return {
          botToken: "",
          appToken: "",
          signingSecret: "",
        };
      }
    },
    {
      response: SlackConfigSchema,
      detail: { tags: ["slack"] },
    },
  )
  .put(
    "/config",
    ({ body, set }) => {
      log.info("Updating Slack configuration");
      const result = configFileService.upsert(
        undefined,
        "slack-config",
        JSON.stringify(body),
        "json",
      );
      set.status = 200;
      return {
        botToken: maskToken(body.botToken),
        appToken: maskToken(body.appToken),
        signingSecret: maskToken(body.signingSecret),
      };
    },
    {
      body: SlackConfigSchema,
      response: SlackConfigSchema,
      detail: { tags: ["slack"] },
    },
  )
  .delete(
    "/config",
    ({ set }) => {
      log.info("Deleting Slack configuration");
      try {
        const configFile = configFileService.getByPath(
          "slack-config",
          "global",
        );
        if (configFile) {
          configFileService.delete(configFile.id);
        }
      } catch (error) {
        log.debug({ error }, "Failed to delete Slack config");
      }
      set.status = 204;
      return null;
    },
    {
      detail: { tags: ["slack"] },
    },
  )
  .get(
    "/threads",
    (): SlackThreadListResponse => {
      return [];
    },
    {
      response: SlackThreadListResponseSchema,
      detail: { tags: ["slack"] },
    },
  )
  .get(
    "/threads/:id",
    ({ set }) => {
      set.status = 404;
      return {
        error: "NOT_FOUND",
        message: "Thread not found",
      };
    },
    {
      detail: { tags: ["slack"] },
    },
  )
  .delete(
    "/threads/:id",
    ({ set }) => {
      set.status = 404;
      return {
        error: "NOT_FOUND",
        message: "Thread not found",
      };
    },
    {
      detail: { tags: ["slack"] },
    },
  );
