/**
 * Text embedders for hybrid search. `HashingEmbedder` is deterministic and
 * network-free (tests, local dev, offline CI); `OpenAICompatibleEmbedder`
 * talks to any OpenAI-`/embeddings`-shaped API for real deployments.
 */
import type { Embedder } from "../types.ts";

function l2Normalize(vector: Float32Array): Float32Array {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i] ?? 0;
    sumSquares += v * v;
  }
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i++) {
    vector[i] = (vector[i] ?? 0) / norm;
  }
  return vector;
}

/** Stable 32-bit hash (FNV-1a): good enough for feature hashing, no crypto. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Deterministic feature-hashed embedding: lowercased word tokens and word
 * bigrams are hashed into `dimensions` buckets (with a sign from the hash,
 * the standard feature-hashing trick to keep the estimator unbiased) and
 * the result is L2-normalised. No model, no network — for tests and
 * environments without an embeddings API.
 */
export class HashingEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;

  constructor(dimensions = 256) {
    this.dimensions = dimensions;
    this.model = `hashing-v1-${dimensions}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): Float32Array {
    const words = tokenize(text);
    const bigrams: string[] = [];
    for (let i = 0; i < words.length - 1; i++) {
      bigrams.push(`${words[i]}_${words[i + 1]}`);
    }
    const vector = new Float32Array(this.dimensions);
    for (const feature of [...words, ...bigrams]) {
      const h = fnv1a(feature);
      const index = h % this.dimensions;
      const sign = h & 1 ? 1 : -1;
      vector[index] = (vector[index] ?? 0) + sign;
    }
    return l2Normalize(vector);
  }
}

export interface OpenAICompatibleEmbedderOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  dimensions: number;
  /** Texts per request (default 64). */
  batchSize?: number;
}

interface OpenAiEmbeddingsResponse {
  data: { embedding: number[]; index: number }[];
}

/**
 * Embedder backed by any OpenAI-compatible `/embeddings` endpoint
 * (`POST {baseUrl}/embeddings`, `{model, input}` → `{data: [{embedding,
 * index}]}`). Output is L2-normalised locally since not every provider
 * guarantees that.
 */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly batchSize: number;

  constructor(opts: OpenAICompatibleEmbedderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.batchSize = opts.batchSize ?? 64;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const result: Float32Array[] = new Array(texts.length);
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      const embeddings = await this.embedBatch(batch);
      embeddings.forEach((vector, i) => {
        result[start + i] = vector;
      });
    }
    return result;
  }

  private async embedBatch(batch: string[]): Promise<Float32Array[]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, input: batch }),
    });
    if (!response.ok) {
      throw new Error(
        `embeddings request failed: ${response.status} ${response.statusText}`,
      );
    }
    const body = (await response.json()) as OpenAiEmbeddingsResponse;
    const ordered = [...body.data].sort((a, b) => a.index - b.index);
    return ordered.map((entry) =>
      l2Normalize(Float32Array.from(entry.embedding)),
    );
  }
}
