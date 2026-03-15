import type { OpenCodeModelConfig } from "./cliproxy.types.ts";

const ANTIGRAVITY_OWNER = "antigravity";

/**
 * Hardcoded metadata for Antigravity models not found in models.dev.
 * Inspired by https://github.com/NoeFabris/opencode-antigravity-auth
 */
const ANTIGRAVITY_HARDCODED_MODELS: Record<string, OpenCodeModelConfig> = {
  "gemini-3.1-pro-high": {
    name: "Gemini 3.1 Pro High",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_535 },
  },
  "gemini-3.1-pro-low": {
    name: "Gemini 3.1 Pro Low",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_535 },
  },
  "gemini-3-pro-high": {
    name: "Gemini 3 Pro High",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_535 },
  },
  "gemini-3-pro-low": {
    name: "Gemini 3 Pro Low",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_535 },
  },
  "gemini-3.1-flash-image": {
    name: "Gemini 3.1 Flash Image",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1_048_576, output: 65_536 },
  },
  "gpt-oss-120b-medium": {
    name: "GPT-OSS 120B Medium",
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 128_000, output: 100_000 },
  },
  "antigravity-sonnet-4-6": {
    name: "Claude Sonnet 4.6 (Antigravity)",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 200_000, output: 64_000 },
  },
  "antigravity-opus-4-6": {
    name: "Claude Opus 4.6 (Antigravity)",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 200_000, output: 64_000 },
  },
};

export { ANTIGRAVITY_HARDCODED_MODELS, ANTIGRAVITY_OWNER };
