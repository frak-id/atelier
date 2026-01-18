import { Elysia } from "elysia";
import type { ExtensionInstallResult } from "../types";
import { ExtensionsInstallSchema } from "../types";
import { exec } from "../utils/exec";

export const vscodeRoutes = new Elysia()
  .get("/vscode/extensions/installed", async () => {
    try {
      const { stdout } = await exec(
        "code-server --list-extensions 2>/dev/null || true",
      );
      const extensions = stdout
        .trim()
        .split("\n")
        .filter((e) => e.length > 0);
      return { extensions };
    } catch {
      return { extensions: [] };
    }
  })
  .post(
    "/vscode/extensions/install",
    async ({ body }) => {
      try {
        const results: ExtensionInstallResult[] = [];
        for (const ext of body.extensions) {
          try {
            await exec(`code-server --install-extension ${ext}`, {
              timeout: 120000,
            });
            results.push({ extension: ext, success: true });
          } catch (error: unknown) {
            const err = error as { message?: string };
            results.push({
              extension: ext,
              success: false,
              error: err.message ?? "Unknown error",
            });
          }
        }
        return { results };
      } catch (error: unknown) {
        const err = error as { message?: string };
        return { error: err.message ?? "Failed to install extensions" };
      }
    },
    {
      body: ExtensionsInstallSchema,
    },
  );
