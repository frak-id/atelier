import { createChildLogger } from "../../shared/lib/logger.ts";
import type { SystemSandboxService } from "../system-sandbox/index.ts";

const log = createChildLogger("title-service");

const MAX_FALLBACK_TITLE_LENGTH = 80;

export class TitleService {
  constructor(private readonly systemSandbox: SystemSandboxService) {}

  async generateTitle(description: string): Promise<string> {
    try {
      return await this.generateViaOpenCode(description);
    } catch (error) {
      log.warn({ error }, "Title generation failed, using fallback");
      return this.fallbackTitle(description);
    }
  }

  private async generateViaOpenCode(description: string): Promise<string> {
    const { client } = await this.systemSandbox.acquire();

    try {
      const { data: session, error: createError } =
        await client.session.create();
      if (createError || !session?.id) {
        throw new Error("Failed to create opencode session for title");
      }

      try {
        const { data, error: promptError } = await client.session.prompt({
          sessionID: session.id,
          agent: "title",
          parts: [{ type: "text", text: description }],
        });

        if (promptError || !data) {
          throw new Error("Title prompt failed");
        }

        const textPart = data.parts.find((p) => p.type === "text");
        if (!textPart || textPart.type !== "text" || !textPart.text.trim()) {
          throw new Error("No text in title response");
        }

        const title = textPart.text.trim();
        log.info({ title }, "Title generated");
        return title;
      } finally {
        await client.session.delete({ sessionID: session.id }).catch(() => {});
      }
    } finally {
      this.systemSandbox.release();
    }
  }

  private fallbackTitle(description: string): string {
    const trimmed = description.trim();
    if (trimmed.length <= MAX_FALLBACK_TITLE_LENGTH) return trimmed;

    const truncated = trimmed.slice(0, MAX_FALLBACK_TITLE_LENGTH);
    const lastSpace = truncated.lastIndexOf(" ");
    return lastSpace > 40
      ? `${truncated.slice(0, lastSpace)}...`
      : `${truncated}...`;
  }
}
