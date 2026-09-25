import { afterAll, describe, expect, test } from "bun:test";
import { HashingEmbedder, OpenAICompatibleEmbedder } from "./embedders.ts";

function norm(vector: Float32Array): number {
  let sum = 0;
  for (const v of vector) sum += v * v;
  return Math.sqrt(sum);
}

describe("HashingEmbedder", () => {
  test("is deterministic and L2-normalised", async () => {
    const embedder = new HashingEmbedder(64);
    const [a] = await embedder.embed(["hello world"]);
    const [b] = await embedder.embed(["hello world"]);
    expect(a).toEqual(b);
    expect(a).toBeDefined();
    if (a) expect(norm(a)).toBeCloseTo(1, 5);
  });

  test("model name encodes dimensions", () => {
    const embedder = new HashingEmbedder(128);
    expect(embedder.model).toBe("hashing-v1-128");
    expect(embedder.dimensions).toBe(128);
  });

  test("different texts usually produce different vectors", async () => {
    const embedder = new HashingEmbedder(64);
    const [a, b] = await embedder.embed(["kubernetes cluster", "banana bread"]);
    expect(a).not.toEqual(b);
  });

  test("empty text yields a zero vector, not a crash", async () => {
    const embedder = new HashingEmbedder(32);
    const [v] = await embedder.embed([""]);
    expect(v).toBeDefined();
    if (v) expect(norm(v)).toBe(0);
  });
});

describe("OpenAICompatibleEmbedder", () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { model: string; input: string[] };
      const data = body.input.map((text, index) => ({
        index,
        embedding: Array.from({ length: 4 }, (_, i) => (text.length + i) / 10),
      }));
      return Response.json({ data, model: body.model });
    },
  });
  afterAll(() => server.stop(true));

  test("embeds via the OpenAI-compatible endpoint, normalised", async () => {
    const embedder = new OpenAICompatibleEmbedder({
      baseUrl: `http://localhost:${server.port}`,
      model: "test-model",
      dimensions: 4,
    });
    const vectors = await embedder.embed(["hi", "hello there"]);
    expect(vectors).toHaveLength(2);
    for (const v of vectors) expect(norm(v)).toBeCloseTo(1, 5);
  });

  test("batches requests according to batchSize", async () => {
    let requestCount = 0;
    const batchServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        requestCount++;
        const body = (await req.json()) as { input: string[] };
        const data = body.input.map((_, index) => ({
          index,
          embedding: [1, 0, 0],
        }));
        return Response.json({ data });
      },
    });
    try {
      const embedder = new OpenAICompatibleEmbedder({
        baseUrl: `http://localhost:${batchServer.port}`,
        model: "m",
        dimensions: 3,
        batchSize: 2,
      });
      const vectors = await embedder.embed(["a", "b", "c", "d", "e"]);
      expect(vectors).toHaveLength(5);
      expect(requestCount).toBe(3); // ceil(5/2)
    } finally {
      batchServer.stop(true);
    }
  });
});
