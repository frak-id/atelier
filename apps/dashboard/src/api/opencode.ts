import { createOpencodeClient } from "@opencode-ai/sdk";

export type OpencodeClient = ReturnType<typeof createOpencodeClient>;

export function createOpencode(baseUrl: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl,
    throwOnError: false,
  });
}

export interface OpenCodeSession {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export interface OpenCodeMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface OpenCodeHealth {
  version: string;
  status: "ok" | "error";
}

export async function fetchOpenCodeHealth(
  baseUrl: string,
): Promise<OpenCodeHealth | null> {
  try {
    const response = await fetch(`${baseUrl}/global/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

export async function fetchOpenCodeSessions(
  baseUrl: string,
): Promise<OpenCodeSession[]> {
  try {
    const response = await fetch(`${baseUrl}/session`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function fetchOpenCodeSession(
  baseUrl: string,
  sessionId: string,
): Promise<OpenCodeSession | null> {
  try {
    const response = await fetch(`${baseUrl}/session/${sessionId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

export async function fetchOpenCodeMessages(
  baseUrl: string,
  sessionId: string,
): Promise<OpenCodeMessage[]> {
  try {
    const response = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function deleteOpenCodeSession(
  baseUrl: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/session/${sessionId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
