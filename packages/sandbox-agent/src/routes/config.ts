import { readFile, stat } from "node:fs/promises";
import { Elysia } from "elysia";
import {
  OPENCODE_AUTH_PATH,
  OPENCODE_CONFIG_PATH,
  VSCODE_EXTENSIONS_PATH,
  VSCODE_SETTINGS_PATH,
} from "../constants";
import { ConfigReadQuerySchema } from "../types";
import { discoverConfigFiles, loadConfig } from "../utils/config";

export const configRoutes = new Elysia()
  .get("/config", async () => {
    const config = await loadConfig();
    return config ?? { error: "Config not found" };
  })
  .get("/editor-config", async () => {
    const [vscodeSettings, vscodeExtensions, opencodeAuth, opencodeConfig] =
      await Promise.all([
        readFile(VSCODE_SETTINGS_PATH, "utf-8").catch(() => "{}"),
        readFile(VSCODE_EXTENSIONS_PATH, "utf-8").catch(() => "[]"),
        readFile(OPENCODE_AUTH_PATH, "utf-8").catch(() => "{}"),
        readFile(OPENCODE_CONFIG_PATH, "utf-8").catch(() => "{}"),
      ]);

    return {
      vscode: {
        settings: JSON.parse(vscodeSettings),
        extensions: JSON.parse(vscodeExtensions),
      },
      opencode: {
        auth: JSON.parse(opencodeAuth),
        config: JSON.parse(opencodeConfig),
      },
    };
  })
  .get("/config/discover", () => {
    return { configs: discoverConfigFiles() };
  })
  .get(
    "/config/read",
    async ({ query, set }) => {
      const path = query.path;
      if (!path) {
        set.status = 400;
        return { error: "path query parameter required" };
      }

      const normalizedPath = path.replace(/^~/, "/home/dev");

      if (
        !normalizedPath.startsWith("/home/dev/") &&
        !normalizedPath.startsWith("/etc/sandbox/")
      ) {
        set.status = 403;
        return {
          error: "Access denied - path must be under /home/dev or /etc/sandbox",
        };
      }

      try {
        const content = await readFile(normalizedPath, "utf-8");
        const stats = await stat(normalizedPath);

        let contentType: "json" | "text" = "text";
        if (normalizedPath.endsWith(".json")) {
          try {
            JSON.parse(content);
            contentType = "json";
          } catch {
            /* empty */
          }
        }

        return {
          path: normalizedPath,
          displayPath: normalizedPath.replace("/home/dev", "~"),
          content,
          contentType,
          size: stats.size,
        };
      } catch {
        set.status = 404;
        return { error: "File not found or not readable" };
      }
    },
    {
      query: ConfigReadQuerySchema,
    },
  );
