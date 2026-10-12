/**
 * The Steery integration ([steery.dev](https://steery.dev)).
 *
 * Outbound (`onPermission`): an agent's permission prompt is raised as a
 * Steery request (`POST /v1/requests`) on the phone of the key's holder, read
 * with a long poll (`GET /v1/requests/{id}?wait_secs=`), and answered with
 * the pressed button. A prompt settled elsewhere withdraws the request
 * (`POST /v1/requests/{id}/report`). Pending requests are not resumed after
 * a server restart (the ACP prompt dies with it too).
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { permissionPresentation } from "@frak/atelier-shared";
import type {
  Integration,
  PermissionContext,
  PermissionRequest,
} from "../integration.ts";

/** Default bound on the raise and withdraw calls. */
const REQUEST_TIMEOUT_MS = 15_000;
/** How long one Steery read blocks before reading again. */
const WAIT_SECS = 300;
/** Default bound on one read: it may block `WAIT_SECS`, plus some slack. */
const READ_TIMEOUT_MS = WAIT_SECS * 1000 + 15_000;
/** Backoff between failed reads, as Steery's docs ask: 1, 2, 5, 10, then 30 s. */
const BACKOFF_SECS = [1, 2, 5, 10, 30];

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Injectable for tests: the network, the backoff wait and the timeouts. */
interface SteeryDeps {
  fetch?: FetchLike;
  /** Wait between failed reads; rejects when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
  readTimeoutMs?: number;
}

/** Nobody reads these bodies; cancelling frees the socket. */
function discard(res: Response): void {
  void res.body?.cancel().catch(() => {});
}

interface SteeryRequest {
  status: "open" | "responded" | "withdrawn";
  response?: { answer?: { values?: Record<string, unknown> } };
}

export function steery(deps: SteeryDeps = {}): Integration {
  const call: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const sleep =
    deps.sleep ??
    ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const readTimeoutMs = deps.readTimeoutMs ?? READ_TIMEOUT_MS;

  async function onPermission(
    request: PermissionRequest,
    ctx: PermissionContext,
  ): Promise<void> {
    const key = ctx.connection.credential;
    if (!key) throw new Error("connection has no Steery API key");
    const url = ctx.serverSettings.url;
    if (!url) throw new Error("missing url setting");
    // The prompt was settled while the hub was getting here.
    if (ctx.signal.aborted) return;
    const base = url.replace(/\/+$/, "");
    const headers = {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    };
    const id = randomUUID();
    // Redirects are refused: the configured URL is the only host the key is
    // ever sent to.
    // A failed call's message may embed the request (headers included), so
    // errors are scrubbed of the key before they are logged or thrown.
    const safe = (err: unknown) =>
      new Error(
        (err instanceof Error ? err.message : String(err))
          .split(key)
          .join("***"),
      );
    const send = (path: string, init: RequestInit) =>
      call(`${base}${path}`, { headers, redirect: "manual", ...init });

    const withdraw = async () => {
      try {
        const res = await send(`/v1/requests/${id}/report`, {
          method: "POST",
          signal: AbortSignal.timeout(requestTimeoutMs),
          body: JSON.stringify({
            state: "withdrawn",
            detail: "Answered in Atelier",
          }),
        });
        discard(res);
      } catch (err) {
        ctx.log.warn({ err: safe(err), id }, "steery withdraw failed");
      }
    };

    // Not aborted by `ctx.signal` mid-flight: a raise that may have landed
    // must be withdrawn by its id, never left open. Only the timeout bounds
    // it, and a timed-out raise may have landed too, so it is withdrawn.
    let raised: Response;
    try {
      raised = await send("/v1/requests", {
        method: "POST",
        signal: AbortSignal.timeout(requestTimeoutMs),
        body: JSON.stringify(steeryRequestBody(id, request)),
      });
    } catch (err) {
      await withdraw();
      throw safe(err);
    }
    if (!raised.ok) {
      discard(raised);
      await withdraw();
      throw new Error(`POST /v1/requests: ${raised.status}`);
    }

    let failures = 0;
    while (!ctx.signal.aborted) {
      let read: SteeryRequest;
      try {
        const res = await send(`/v1/requests/${id}?wait_secs=${WAIT_SECS}`, {
          signal: AbortSignal.any([
            ctx.signal,
            AbortSignal.timeout(readTimeoutMs),
          ]),
        });
        if (!res.ok) {
          discard(res);
          throw new Error(`GET /v1/requests: ${res.status}`);
        }
        read = (await res.json()) as SteeryRequest;
        failures = 0;
      } catch (err) {
        if (ctx.signal.aborted) break;
        const secs =
          BACKOFF_SECS[Math.min(failures++, BACKOFF_SECS.length - 1)] ?? 30;
        ctx.log.debug(
          { err: safe(err), id, secs },
          "steery read failed; retrying",
        );
        try {
          await sleep(secs * 1000, ctx.signal);
        } catch {
          break; // aborted while backing off
        }
        continue;
      }
      if (read.status === "open") continue;
      // Answered (or withdrawn by hand): nothing left to withdraw.
      const choice = read.response?.answer?.values?.choice;
      if (
        typeof choice === "string" &&
        request.options.some((o) => o.optionId === choice)
      ) {
        ctx.answer(choice);
      }
      return;
    }
    // Settled without Steery: take the request off the phone.
    await withdraw();
  }

  return {
    manifest: {
      id: "steery",
      label: "Steery",
      description:
        "Answer your agents' permission prompts from your phone, and let Steery run its conversations in Atelier sandboxes.",
      docsUrl: "https://steery.dev",
      serverSettings: [
        {
          name: "url",
          type: "url",
          default: "https://steery.dev",
        },
      ],
      credential: {
        label: "Steery API key",
        required: true,
        help: "Create one with `steery keys create --name atelier`; its `secret` is shown once. Requests are raised as the person who owns that key.",
      },
    },
    onPermission,
  };
}

/** The default instance, on the global `fetch`. */
export const steeryIntegration = steery();

/** Agent-controlled text goes into markdown: no code spans, one line. */
const plain = (text: string) =>
  text.replace(/[`[\]()*_<>]/g, "").replace(/\s+/g, " ");

/** The Steery request for one prompt: its options as buttons, the first
 * reject option carrying the `rejection` stance. */
function steeryRequestBody(id: string, request: PermissionRequest) {
  const { what, riskLabel } = permissionPresentation(
    request.title,
    request.kind,
  );
  const rejection = request.options.find((o) => o.kind.startsWith("reject"));
  return {
    id,
    // At most 8 words: "Let the agent run a command?"
    title: `Let the agent ${what.toLowerCase()}?`
      .split(/\s+/)
      .slice(0, 8)
      .join(" "),
    body: [
      `- The agent in sandbox **${plain(request.sandboxName)}** asks to **${plain(request.title)}** (${riskLabel}).`,
      `  - Tool kind: ${request.kind ?? "unknown"}.`,
      "  - Atelier passes your answer to the agent; answering in the Atelier console first withdraws this.",
      "- **Pick the answer** the agent gets.",
    ].join("\n"),
    input: [
      {
        kind: "buttons",
        name: "choice",
        options: request.options.map((o) => ({
          id: o.optionId,
          label: o.name.split(/\s+/).slice(0, 3).join(" "),
          stance: o === rejection ? "rejection" : "neutral",
        })),
      },
    ],
  };
}
