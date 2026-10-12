/**
 * The Steery permission notifier: raises an agent's permission prompt as a
 * Steery request (`POST /v1/requests`) on the phone of whoever holds the org's
 * Steery key, waits on it (`GET /v1/requests/{id}?wait_secs=`), and answers
 * the prompt with the pressed button. A prompt answered in the console first
 * withdraws the request (`POST /v1/requests/{id}/report`). Pending requests
 * are not resumed after a server restart (the ACP prompt dies with it too).
 *
 * Structurally implements sessions/' `PermissionNotifier`; control/ never
 * imports sessions/, the composition root (api/container.ts) joins them.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { SANDBOX_NAME_ANNOTATION, SANDBOX_ORG_ANNOTATION } from "@atelier/spec";
import {
  permissionPresentation,
  STEERY_API_KEY_SECRET,
  STEERY_NOTIFY_ANNOTATION,
  SteeryNotifyModeSchema,
  type SteeryNotifyPolicy,
} from "@frak/atelier-shared";
import { Value } from "@sinclair/typebox/value";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type { SecretService } from "../secret/index.ts";
import { notifies, type SteeryNotifyService } from "./steery-notify.service.ts";

const log = createChildLogger("steery-notifier");

/** How long one Steery read blocks before reading again. */
const WAIT_SECS = 300;
/** Backoff between failed reads, as Steery's docs ask: 1, 2, 5, 10, then 30 s. */
const BACKOFF_SECS = [1, 2, 5, 10, 30];

interface Prompt {
  sandboxId: string;
  title: string;
  kind?: string;
  options: { optionId: string; name: string; kind: string }[];
}

interface SteeryRequest {
  status: "open" | "responded" | "withdrawn";
  response?: { answer?: { values?: Record<string, unknown> } };
}

export class SteeryNotifier {
  constructor(
    private readonly deps: {
      policies: SteeryNotifyService;
      secrets: SecretService;
      /** A sandbox's stored annotations, or undefined when it is unknown. */
      annotations: (sandboxId: string) => Record<string, string> | undefined;
    },
  ) {}

  notify(
    prompt: Prompt,
    answer: (optionId: string) => void,
    signal: AbortSignal,
  ): void {
    const annotations = this.deps.annotations(prompt.sandboxId);
    const orgId = annotations?.[SANDBOX_ORG_ANNOTATION];
    if (!orgId) return;
    const policy = this.deps.policies.get(orgId);
    const override = annotations?.[STEERY_NOTIFY_ANNOTATION];
    const mode = Value.Check(SteeryNotifyModeSchema, override)
      ? override
      : policy.mode;
    if (!notifies(policy, mode, prompt)) return;
    const name = annotations?.[SANDBOX_NAME_ANNOTATION] ?? prompt.sandboxId;
    void this.ask(policy, orgId, name, prompt, answer, signal).catch((err) => {
      if (!signal.aborted) {
        log.warn({ err, sandboxId: prompt.sandboxId }, "steery request failed");
      }
    });
  }

  private async ask(
    policy: SteeryNotifyPolicy,
    orgId: string,
    sandboxName: string,
    prompt: Prompt,
    answer: (optionId: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    // Ask the phone only if the console has not answered by then.
    if (policy.delaySeconds > 0) {
      await sleep(policy.delaySeconds * 1000, undefined, { signal });
    }
    const key = await this.deps.secrets.resolve(orgId, STEERY_API_KEY_SECRET);
    const base = policy.steeryUrl.replace(/\/+$/, "");
    const headers = {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    };
    const id = randomUUID();
    // Not aborted mid-flight: a raise that may have landed must be withdrawn
    // by its id, never left open.
    const raised = await fetch(`${base}/v1/requests`, {
      method: "POST",
      headers,
      body: JSON.stringify(steeryRequestBody(id, sandboxName, prompt)),
    });
    if (!raised.ok) {
      throw new Error(
        `POST /v1/requests: ${raised.status} ${await raised.text()}`,
      );
    }

    // Answered in the console first (or the connection closed): withdraw.
    const withdraw = () => {
      void fetch(`${base}/v1/requests/${id}/report`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          state: "withdrawn",
          detail: "Answered in Atelier",
        }),
      }).catch((err) => log.warn({ err, id }, "steery withdraw failed"));
    };
    if (signal.aborted) return withdraw();
    signal.addEventListener("abort", withdraw, { once: true });

    let failures = 0;
    while (!signal.aborted) {
      let request: SteeryRequest;
      try {
        const read = await fetch(
          `${base}/v1/requests/${id}?wait_secs=${WAIT_SECS}`,
          { headers, signal },
        );
        if (!read.ok) throw new Error(`GET /v1/requests: ${read.status}`);
        request = (await read.json()) as SteeryRequest;
        failures = 0;
      } catch (err) {
        if (signal.aborted) return;
        const secs =
          BACKOFF_SECS[Math.min(failures++, BACKOFF_SECS.length - 1)];
        log.debug({ err, id, secs }, "steery read failed; retrying");
        await sleep((secs ?? 30) * 1000, undefined, { signal });
        continue;
      }
      if (request.status === "open") continue;
      signal.removeEventListener("abort", withdraw);
      const choice = request.response?.answer?.values?.choice;
      if (typeof choice === "string") answer(choice);
      return;
    }
  }
}

/** The Steery request for one prompt: its options as buttons, the first
 * reject option carrying the `rejection` stance. */
export function steeryRequestBody(
  id: string,
  sandboxName: string,
  prompt: Prompt,
) {
  const { what, riskLabel } = permissionPresentation(prompt.title);
  const rejection = prompt.options.find((o) => o.kind.startsWith("reject"));
  return {
    id,
    // At most 8 words: "Let the agent run a command?"
    title: `Let the agent ${what.toLowerCase()}?`
      .split(/\s+/)
      .slice(0, 8)
      .join(" "),
    body: [
      `- The agent in sandbox **${sandboxName}** asks to **${prompt.title}** (${riskLabel}).`,
      `  - Tool kind: ${prompt.kind ?? "unknown"}.`,
      "  - Atelier passes your answer to the agent; answering in the Atelier console first withdraws this.",
      "- **Pick the answer** the agent gets.",
    ].join("\n"),
    input: [
      {
        kind: "buttons",
        name: "choice",
        options: prompt.options.map((o) => ({
          id: o.optionId,
          label: o.name.split(/\s+/).slice(0, 3).join(" "),
          stance: o === rejection ? "rejection" : "neutral",
        })),
      },
    ],
  };
}
