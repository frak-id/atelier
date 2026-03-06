import type { AtelierConfig } from "./client";
import { AtelierClient } from "./client";

interface WorkspaceInfo {
  id: string;
  type: string;
  branch?: string;
  name?: string;
  directory?: string;
  extra?: unknown;
  projectID: string;
}

interface Adaptor {
  configure(input: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>;
  create(input: WorkspaceInfo, from?: WorkspaceInfo): Promise<void>;
  remove(config: WorkspaceInfo): Promise<void>;
  fetch(
    config: WorkspaceInfo,
    input: FetchInput,
    init?: RequestInit,
  ): Promise<Response>;
}

type FetchInput = string | URL | Request;

interface AtelierExtra {
  sandboxId: string;
  workspaceId: string;
  opencodeUrl: string;
  password?: string;
}

interface AtelierCreateExtra {
  remoteUrl?: string;
  branch?: string;
}

export interface AtelierAdaptorConfig extends AtelierConfig {
  remoteUrl?: string;
  branch?: string;
  defaultName?: string;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toRequestUrl(input: FetchInput): URL {
  if (input instanceof URL) {
    return input;
  }
  if (input instanceof Request) {
    return new URL(input.url);
  }
  return new URL(input, "http://opencode.internal");
}

function toBasicAuth(password: string): string {
  const raw = `opencode:${password}`;
  if (typeof btoa === "function") {
    return `Basic ${btoa(raw)}`;
  }
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

function parseExtra(
  value: unknown,
): Partial<AtelierExtra & AtelierCreateExtra> {
  return toRecord(value) as Partial<AtelierExtra & AtelierCreateExtra>;
}

export function createAtelierAdaptor(config: AtelierAdaptorConfig): Adaptor {
  const client = new AtelierClient(config);

  return {
    configure(input) {
      const baseExtra = toRecord(input.extra);
      const nextExtra: Record<string, unknown> = { ...baseExtra };
      if (config.remoteUrl && typeof nextExtra.remoteUrl !== "string") {
        nextExtra.remoteUrl = config.remoteUrl;
      }
      if (config.branch && typeof nextExtra.branch !== "string") {
        nextExtra.branch = config.branch;
      }
      return {
        ...input,
        type: "atelier",
        name: input.name ?? config.defaultName ?? "atelier-sandbox",
        extra: nextExtra,
      };
    },

    async create(input) {
      const extra = parseExtra(input.extra);
      const remoteUrl = extra.remoteUrl ?? config.remoteUrl;
      if (!remoteUrl) {
        throw new Error("Atelier remoteUrl is required");
      }
      const branch = input.branch ?? extra.branch ?? config.branch;
      const spawned = await client.spawn(remoteUrl, branch);
      input.extra = {
        ...toRecord(input.extra),
        remoteUrl,
        branch,
        sandboxId: spawned.sandboxId,
        workspaceId: spawned.workspaceId,
        opencodeUrl: spawned.opencodeUrl,
        password: spawned.password,
      };
      input.name = input.name ?? spawned.workspaceName;
      input.type = "atelier";
    },

    async remove(input) {
      const extra = parseExtra(input.extra);
      if (!extra.sandboxId) {
        return;
      }
      await client.destroySandbox(extra.sandboxId);
    },

    async fetch(info, input, init) {
      const extra = parseExtra(info.extra);
      if (!extra.opencodeUrl) {
        throw new Error("Atelier opencodeUrl is missing");
      }

      const source = toRequestUrl(input);
      const target = new URL(
        `${source.pathname}${source.search}${source.hash}`,
        extra.opencodeUrl,
      );

      let request =
        input instanceof Request
          ? new Request(target.toString(), input)
          : new Request(target.toString(), init);
      if (input instanceof Request && init) {
        request = new Request(request, init);
      }

      const headers = new Headers(request.headers);
      if (extra.password) {
        headers.set("Authorization", toBasicAuth(extra.password));
      }

      request = new Request(request, { headers });
      return fetch(request);
    },
  };
}

export type { Adaptor, AtelierExtra, WorkspaceInfo };
