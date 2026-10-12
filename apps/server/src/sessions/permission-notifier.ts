/**
 * Somewhere else to ask an agent's permission prompt (a person's phone), next
 * to the console. sessions/ owns only this seam; the implementation (policy,
 * credentials, the remote service) lives in control/ and is wired in
 * api/container.ts, so sessions/ never imports control/.
 */

/** One ACP `session/request_permission`, as a notifier sees it. */
export interface PermissionPrompt {
  sandboxId: string;
  sessionId: string;
  /** The pending permission id — what the public reply route takes. */
  requestId: string;
  /** The tool call's title, else its kind, else "permission". */
  title: string;
  /** The ACP tool kind (`edit`, `execute`, `fetch`, …), when given. */
  kind?: string;
  /** The answers the agent offers, in its order. */
  options: { optionId: string; name: string; kind: string }[];
}

export interface PermissionNotifier {
  /**
   * Ask elsewhere. `answer` settles the prompt with one of the offered
   * `optionId`s; the first answer (here or in the console) wins. `signal`
   * aborts once the prompt is settled without this notifier (answered in
   * the console, or its connection closed): withdraw what was raised.
   */
  notify(
    prompt: PermissionPrompt,
    answer: (optionId: string) => void,
    signal: AbortSignal,
  ): void;
}
