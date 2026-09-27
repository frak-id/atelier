import { describe, expect, test } from "bun:test";

import { OnyxClient, OnyxError } from "./onyx.ts";
import type { OnyxDocument } from "./pages.ts";

function fakeFetch(
  handler: (input: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fn, calls };
}

const sampleDoc: OnyxDocument = {
  id: "codewiki:frak-id/atelier:CI_CD_Workflows",
  semanticIdentifier: "atelier · CI/CD Workflows",
  title: "CI/CD Workflows",
  sections: [{ text: "# CI/CD Workflows\n\nbody", link: "https://x" }],
  metadata: { repo: "frak-id/atelier", generator: "codewiki" },
  docUpdatedAt: "2026-09-28T00:00:00.000Z",
};

describe("OnyxClient.upsert", () => {
  test("POSTs the expected body shape with the bearer auth header", async () => {
    const { fn, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
    const client = new OnyxClient({
      baseUrl: "http://onyx-api-service.onyx.svc.cluster.local:8080",
      apiKey: "onyx-key",
      ccPairId: 7,
      fetchImpl: fn,
    });

    await client.upsert(sampleDoc);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "http://onyx-api-service.onyx.svc.cluster.local:8080/onyx-api/ingestion",
    );
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer onyx-key");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toEqual({
      document: {
        id: sampleDoc.id,
        sections: sampleDoc.sections,
        semantic_identifier: sampleDoc.semanticIdentifier,
        title: sampleDoc.title,
        metadata: sampleDoc.metadata,
        doc_updated_at: sampleDoc.docUpdatedAt,
      },
      cc_pair_id: 7,
    });
  });

  test("retries on 5xx and eventually succeeds", async () => {
    let attempt = 0;
    const { fn, calls } = fakeFetch(() => {
      attempt++;
      if (attempt < 3) return new Response("boom", { status: 503 });
      return new Response("{}", { status: 200 });
    });
    const client = new OnyxClient({
      baseUrl: "http://onyx",
      apiKey: "k",
      ccPairId: 1,
      fetchImpl: fn,
      retryDelayMs: 1,
    });

    await client.upsert(sampleDoc);
    expect(calls).toHaveLength(3);
  });

  test("retries on 429", async () => {
    let attempt = 0;
    const { fn } = fakeFetch(() => {
      attempt++;
      return attempt < 2
        ? new Response("slow down", { status: 429 })
        : new Response("{}", { status: 200 });
    });
    const client = new OnyxClient({
      baseUrl: "http://onyx",
      apiKey: "k",
      ccPairId: 1,
      fetchImpl: fn,
      retryDelayMs: 1,
    });
    await expect(client.upsert(sampleDoc)).resolves.toBeUndefined();
  });

  test("gives up after maxRetries and throws OnyxError", async () => {
    const { fn, calls } = fakeFetch(
      () => new Response("down", { status: 500 }),
    );
    const client = new OnyxClient({
      baseUrl: "http://onyx",
      apiKey: "k",
      ccPairId: 1,
      fetchImpl: fn,
      retryDelayMs: 1,
      maxRetries: 2,
    });
    await expect(client.upsert(sampleDoc)).rejects.toBeInstanceOf(OnyxError);
    expect(calls).toHaveLength(3);
  });

  test("does not retry a 4xx (other than 429)", async () => {
    const { fn, calls } = fakeFetch(() => new Response("bad", { status: 400 }));
    const client = new OnyxClient({
      baseUrl: "http://onyx",
      apiKey: "k",
      ccPairId: 1,
      fetchImpl: fn,
      retryDelayMs: 1,
    });
    await expect(client.upsert(sampleDoc)).rejects.toBeInstanceOf(OnyxError);
    expect(calls).toHaveLength(1);
  });
});

describe("OnyxClient.delete", () => {
  test("DELETEs the encoded document id", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const client = new OnyxClient({
      baseUrl: "http://onyx",
      apiKey: "k",
      ccPairId: 1,
      fetchImpl: fn,
    });
    await client.delete("codewiki:frak-id/atelier:CI_CD_Workflows");
    expect(calls[0]?.url).toBe(
      "http://onyx/onyx-api/ingestion/codewiki%3Afrak-id%2Fatelier%3ACI_CD_Workflows",
    );
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  test("treats a 404 (already deleted) as success", async () => {
    const { fn, calls } = fakeFetch(
      () => new Response("not found", { status: 404 }),
    );
    const client = new OnyxClient({
      baseUrl: "http://onyx",
      apiKey: "k",
      ccPairId: 1,
      fetchImpl: fn,
    });
    await expect(client.delete("already-gone")).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test("still throws on a non-404 4xx", async () => {
    const { fn } = fakeFetch(() => new Response("nope", { status: 403 }));
    const client = new OnyxClient({
      baseUrl: "http://onyx",
      apiKey: "k",
      ccPairId: 1,
      fetchImpl: fn,
    });
    await expect(client.delete("x")).rejects.toBeInstanceOf(OnyxError);
  });

  test("still retries and eventually throws on repeated 5xx", async () => {
    const { fn, calls } = fakeFetch(
      () => new Response("down", { status: 500 }),
    );
    const client = new OnyxClient({
      baseUrl: "http://onyx",
      apiKey: "k",
      ccPairId: 1,
      fetchImpl: fn,
      retryDelayMs: 1,
      maxRetries: 1,
    });
    await expect(client.delete("x")).rejects.toBeInstanceOf(OnyxError);
    expect(calls).toHaveLength(2);
  });
});

describe("OnyxClient.list", () => {
  test("GETs and parses the ingested-doc list", async () => {
    const { fn } = fakeFetch(
      () =>
        new Response(
          JSON.stringify([
            { document_id: "a", semantic_id: "A", link: "https://x/a" },
          ]),
          { status: 200 },
        ),
    );
    const client = new OnyxClient({
      baseUrl: "http://onyx",
      apiKey: "k",
      ccPairId: 1,
      fetchImpl: fn,
    });
    const docs = await client.list();
    expect(docs).toEqual([
      { document_id: "a", semantic_id: "A", link: "https://x/a" },
    ]);
  });
});
