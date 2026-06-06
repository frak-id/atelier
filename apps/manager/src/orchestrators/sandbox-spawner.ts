import { customAlphabet } from "nanoid";
import { eventBus } from "../infrastructure/events/index.ts";
import type {
  CreateSandboxBody,
  CreateSandboxResponse,
  Sandbox,
  Workspace,
} from "../schemas/index.ts";
import { isMock } from "../shared/lib/config.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { SandboxPorts } from "./ports/sandbox-ports.ts";
import { toolUrl } from "./tools/registry.ts";
import { createWorkspaceSandbox } from "./workflows/index.ts";

const log = createChildLogger("sandbox-spawner");

export class SandboxSpawner {
  constructor(private readonly ports: SandboxPorts) {}

  async spawn(
    options: CreateSandboxBody = {},
    createdByUserId?: string,
  ): Promise<CreateSandboxResponse> {
    const sandboxId = safeNanoid();
    if (!options.workspaceId) {
      throw new Error("workspaceId is required for workspace sandbox");
    }

    const workspace = this.ports.workspaces.getById(options.workspaceId);

    if (isMock()) {
      return this.spawnMock(sandboxId, workspace, options);
    }

    if (!workspace) {
      throw new Error("Workspace not found for workspace sandbox");
    }

    return createWorkspaceSandbox(
      sandboxId,
      workspace,
      options,
      this.ports,
      createdByUserId,
    );
  }

  private async spawnMock(
    sandboxId: string,
    workspace: Workspace | undefined,
    options: CreateSandboxBody,
  ): Promise<Sandbox> {
    const generatePassword = customAlphabet(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    );

    const sandbox: Sandbox = {
      id: sandboxId,
      status: "running",
      workspaceId: options.workspaceId,
      name: options.name ?? workspace?.name,
      origin: options.origin,
      runtime: {
        ipAddress: "10.42.0.99",
        macAddress: "",
        urls: {
          vscode: toolUrl("vscode", sandboxId) ?? "",
          opencode: toolUrl("opencode", sandboxId) ?? "",
          ssh: "",
        },
        vcpus: options.vcpus ?? workspace?.config.vcpus ?? 2,
        memoryMb: options.memoryMb ?? workspace?.config.memoryMb ?? 2048,
        opencodePassword: generatePassword(32),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.ports.sandbox.create(sandbox);
    eventBus.emit({
      type: "sandbox.created",
      properties: {
        id: sandboxId,
        workspaceId: options.workspaceId,
      },
    });

    log.info({ sandboxId }, "Mock sandbox created");
    return sandbox;
  }
}
