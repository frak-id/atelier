export type IntegrationCommand =
  | { type: "continue"; text: string }
  | { type: "new"; text: string }
  | { type: "add"; text: string }
  | { type: "review"; text: string }
  | { type: "security"; text: string }
  | { type: "simplify"; text: string }
  | { type: "dev"; action: string; name?: string }
  | { type: "cancel" }
  | { type: "restart"; text: string }
  | { type: "status" }
  | { type: "help" };

const COMMAND_REGEX =
  /^\/?(new|add|review|security|simplify|dev|cancel|restart|status|help)\b/i;

function stripMentionPrefix(text: string): string {
  return text.replace(/^\s*<@[^>]+>\s*:?[\s]*/i, "").trim();
}

export function parseMention(rawText: string): IntegrationCommand {
  const cleanedText = stripMentionPrefix(rawText);
  const match = cleanedText.match(COMMAND_REGEX);

  if (!match) {
    return { type: "continue", text: cleanedText };
  }

  const command = (match[1] ?? "").toLowerCase();
  const rest = cleanedText.slice(match[0].length).trim();

  if (command === "dev") {
    const [actionPart, namePart] = rest.split(/\s+/, 2);
    const action = actionPart?.toLowerCase() ?? "list";
    const name = namePart?.trim();
    return { type: "dev", action, ...(name ? { name } : {}) };
  }

  if (command === "new") {
    return { type: "new", text: rest };
  }

  if (command === "add") {
    return { type: "add", text: rest };
  }

  if (command === "review") {
    return { type: "review", text: rest };
  }

  if (command === "security") {
    return { type: "security", text: rest };
  }

  if (command === "simplify") {
    return { type: "simplify", text: rest };
  }

  if (command === "cancel") {
    return { type: "cancel" };
  }

  if (command === "restart") {
    return { type: "restart", text: rest };
  }

  if (command === "status") {
    return { type: "status" };
  }

  return { type: "help" };
}
