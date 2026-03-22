import type { ProgressState, TodoItem } from "../integration.types.ts";

const MAX_DISPLAY_TODOS = 15;

const TODO_CHECKBOX: Record<TodoItem["status"], string> = {
  completed: "[x]",
  in_progress: "[ ]",
  pending: "[ ]",
  cancelled: "[ ]",
};

export function renderProgressMarkdown(state: ProgressState): string {
  const lines: string[] = [];

  lines.push("<!-- atelier-progress -->");
  lines.push("");
  lines.push(progressHeader(state));
  lines.push("");
  lines.push(
    `[:computer: Dashboard](${state.urls.dashboard}) · [:brain: OpenCode](${state.urls.opencode})`,
  );

  if (state.attention) {
    const icon =
      state.attention.type === "permission" ? ":raised_hand:" : ":question:";
    lines.push("");
    lines.push("## Attention Required");
    lines.push(
      `${icon} ${state.attention.description} — [Answer in Dashboard](${state.attention.url})`,
    );
  }

  const activeTodos = state.todos.filter((todo) => todo.status !== "cancelled");
  if (activeTodos.length > 0) {
    const completed = activeTodos.filter(
      (todo) => todo.status === "completed",
    ).length;

    lines.push("");
    lines.push(`## Progress (${completed}/${activeTodos.length})`);

    const visible = activeTodos.slice(0, MAX_DISPLAY_TODOS);
    for (const todo of visible) {
      const suffix = todo.status === "in_progress" ? " _(in progress)_" : "";
      lines.push(`- ${TODO_CHECKBOX[todo.status]} ${todo.content}${suffix}`);
    }

    if (activeTodos.length > MAX_DISPLAY_TODOS) {
      lines.push(`- [ ] …and ${activeTodos.length - MAX_DISPLAY_TODOS} more`);
    }
  }

  return lines.join("\n");
}

function progressHeader(state: ProgressState): string {
  switch (state.status) {
    case "completed": {
      const dur = state.duration ? ` — ${state.duration}` : "";
      return `:white_check_mark: **Agent finished**${dur}`;
    }
    case "attention":
      return ":warning: **Agent needs input**";
    case "running":
      return ":hourglass_flowing_sand: **Agent working**";
    default:
      return ":rocket: **Agent started**";
  }
}
