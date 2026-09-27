/** Minimal client for Onyx's ingestion API
 * (backend/onyx/server/onyx_api/ingestion.py): upsert-by-document.id, delete,
 * list. Retries 5xx/429 with backoff; every other status is a hard failure. */

import type { OnyxDocument } from "./pages.ts";

export interface OnyxClientOptions {
  baseUrl: string;
  apiKey: string;
  ccPairId: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface IngestedDoc {
  document_id: string;
  semantic_id: string;
  link: string;
}

export class OnyxError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "OnyxError";
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OnyxClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly ccPairId: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(opts: OnyxClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.ccPairId = opts.ccPairId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.status === 429 || res.status >= 500) {
          lastErr = new OnyxError(
            `${method} ${path} -> ${res.status}`,
            res.status,
          );
          if (attempt < this.maxRetries) {
            await sleep(this.retryDelayMs * 2 ** attempt);
            continue;
          }
          throw lastErr;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new OnyxError(
            `${method} ${path} -> ${res.status}: ${text}`,
            res.status,
          );
        }
        return res;
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof OnyxError) throw err;
        lastErr = err;
        if (attempt < this.maxRetries) {
          await sleep(this.retryDelayMs * 2 ** attempt);
          continue;
        }
        throw new OnyxError(
          `${method} ${path} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    throw lastErr instanceof Error ? lastErr : new OnyxError("request failed");
  }

  async upsert(doc: OnyxDocument): Promise<void> {
    await this.request("POST", "/onyx-api/ingestion", {
      document: {
        id: doc.id,
        sections: doc.sections,
        semantic_identifier: doc.semanticIdentifier,
        title: doc.title,
        metadata: doc.metadata,
        doc_updated_at: doc.docUpdatedAt,
      },
      cc_pair_id: this.ccPairId,
    });
  }

  async delete(documentId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/onyx-api/ingestion/${encodeURIComponent(documentId)}`,
    );
  }

  async list(): Promise<IngestedDoc[]> {
    const res = await this.request("GET", "/onyx-api/ingestion");
    return (await res.json()) as IngestedDoc[];
  }
}
